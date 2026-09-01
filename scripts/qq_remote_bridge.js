// QQ Bot persistent remote-control bridge (read-only, ownered-scoped).
// Connects to QQ Open Platform websocket gateway, listens for single-chat
// (C2C_MESSAGE_CREATE) messages from authorized openids only, runs a whitelisted
// read-only command, and replies passively using the event's msg_id.
// Auto-refreshes access_token and auto-reconnects on disconnect.
const fs = require("fs");
const https = require("https");
const path = require("path");
const { execFile, spawn } = require("child_process");

const CONFIG_PATH = path.join(__dirname, "qq_bridge_config.json");
const LOG_PATH = path.join(__dirname, "qq_remote_bridge.log");

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const APP_ID = config.appId;
const CLIENT_SECRET = config.clientSecret;
const AUTHPASS = new Set(config.authorizedOpenids);
const GATEWAY = config.gateway;
const API_HOST = config.apiHost;
const TOKEN_HOST = config.tokenHost;
const REPLY_LIMIT = config.replyContentLimit || 1500;
const CMD_TIMEOUT = config.commandTimeoutMs || 20000;
// Send a startup greeting to every authorized openid when the bot comes
// online (once per daemon process). Disable with "startupGreeting": false.
const STARTUP_GREETING = config.startupGreeting !== false;
// Auto-split one message containing multiple instructions (connectors like
// 然后/接着/接下来/并且…) into a queue of separate tasks. Disable with
// "autoSplitTasks": false.
const AUTO_SPLIT = config.autoSplitTasks !== false;
// Ask the user for one-time network authorization before running a task that
// looks like it needs the network (search / external info). Disable with
// "netTaskAsk": false.
const NET_ASK = config.netTaskAsk !== false;

// Heuristic for likely-online tasks (search / external information). Only a
// hint: the user decides at the prompt.
const NET_TASK_RE = /(搜索|搜一?下|查询|新闻|天气|热点|资讯|热搜|排行|榜单|汇率|股票|行情|网页|网站|下载|百科|快递|物流|航班|视频|直播|动态|头条|大事|发生了什么|世界上|最新)/;

// Heuristic for tasks likely needing full-disk access (outside-workspace
// writes / system operations). Conservative: only clear indicators.
const FULL_TASK_RE = /(全盘|工作区外|C:\\|D:\\|[A-Z]:\\|安装|卸载|服务|注册表|系统设置|环境变量|格式化)/;

// Classify a batch of instruction parts by required permissions.
function classifyBatch(parts) {
  let web = false, full = false;
  for (const p of parts) {
    if (NET_TASK_RE.test(p)) web = true;
    if (FULL_TASK_RE.test(p)) full = true;
    if (web && full) break;
  }
  return { web, full };
}

// Unified permission-request prompt. `items` lists ONLY the instructions that
// need the requested permission (web-access or full-disk).
function buildPermPrompt(permName, items, allowAction, denyAction) {
  const list = (items && items.length ? items : ["<该指令>"]).map((it, i) => "  " + (i + 1) + ". " + String(it).slice(0, 50)).join("\n");
  return "🔐 权限请求 · " + permName + "\n" +
    "📋 需要" + permName + "的指令：\n" + list + "\n" +
    "👉 回复「允许」" + allowAction + "；「拒绝」" + denyAction + "\n" +
    "⏱ 15 秒内未回复默认拒绝，任务不执行。";
}

// 15s confirmation countdown for gated operations (task interruption,
// network authorization, full-access transfer). Timeout defaults to NO
// operation, and the user is told the task was not executed.
const CONFIRM_TIMEOUT_MS = 15000;
// Workspace for every natural-language headless session: all conversations
// spawned by the bridge run inside this directory (the headless runner uses
// process.cwd() as the agent workspace). Portable default: %USERPROFILE%\dsh-qqbot-workspace.
const WORKSPACE = config.workspace || path.join(require("os").homedir(), "dsh-qqbot-workspace");
const INTENTS = 33554432; // GROUP_AND_C2C_EVENT (1<<25)

// ---- logging -------------------------------------------------------------
function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(" ")}`;
  try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch (_) {}
  console.log(line);
}

// ---- access token management --------------------------------------------
let token = null;
let tokenExpiresAt = 0;

function httpJson(hostName, method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (data) {
      h["Content-Type"] = "application/json";
      h["Content-Length"] = Buffer.byteLength(data);
    }
    const req = https.request({ host: hostName, path: pathname, method, headers: h }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    // Stalled connections must fail instead of hanging the reply pipeline
    // forever (a stuck passive reply once froze the daemon after a task).
    req.setTimeout(15000, () => req.destroy(new Error("http timeout " + method + " " + pathname)));
    req.on("error", e => reject(e));
    if (data) req.write(data);
    req.end();
  });
}

async function fetchToken() {
  const r = await httpJson(TOKEN_HOST, "POST", "/app/getAppAccessToken", {}, {
    appId: APP_ID, clientSecret: CLIENT_SECRET
  });
  if (r.status !== 200) {
    log("TOKEN-FETCH FAILED", r.status, r.body);
    throw new Error("token fetch failed " + r.status);
  }
  const j = JSON.parse(r.body);
  token = j.access_token;
  const ttl = Number(j.expires_in) || 7200;
  tokenExpiresAt = Date.now() + (ttl - 60) * 1000; // refresh 60s early
  log("TOKEN refreshed, ttl=" + ttl + "s");
  return token;
}

async function ensureToken() {
  if (token && Date.now() < tokenExpiresAt) return token;
  return fetchToken();
}

// ---- send passive reply --------------------------------------------------
// msg_seq must increase for each reply to the same msg_id, otherwise the
// platform dedups and the second reply fails.
async function replyToUser(userOpenid, msgId, content, msgSeq = 1) {
  const tok = await ensureToken();
  const body = { msg_type: 0, content, msg_id: msgId, msg_seq: msgSeq };
  const r = await httpJson(API_HOST, "POST", "/v2/users/" + encodeURIComponent(userOpenid) + "/messages", {
    Authorization: "QQBot " + tok
  }, body);
  log("REPLY status=" + r.status + " seq=" + msgSeq, r.body.slice(0, 300));
  return r;
}

// Per-msg_id reply-sequence counter (passive replies to the same message must
// carry distinct increasing msg_seq values).
const msgSeqCounter = new Map();
function nextMsgSeq(msgId) {
  const next = (msgSeqCounter.get(msgId) || 0) + 1;
  msgSeqCounter.set(msgId, next);
  return next;
}

// ---- startup greeting (active message on WS READY) -----------------------
// Active (proactive) C2C message: no msg_id, used for the online greeting.
async function activeMessageToUser(userOpenid, content) {
  const tok = await ensureToken();
  const body = { msg_type: 0, content, msg_seq: 1 };
  const r = await httpJson(API_HOST, "POST", "/v2/users/" + encodeURIComponent(userOpenid) + "/messages", {
    Authorization: "QQBot " + tok
  }, body);
  log("ACTIVE status=" + r.status + " openid=" + userOpenid.slice(0, 8) + "… " + r.body.slice(0, 200));
  return r;
}

// 中国法定节假日（放假首日）— 官方安排：国办发明电〔2025〕7 号（2026 年）。
// 每年需更新本表；结构 [月, 日, 名称]。
const CN_HOLIDAYS = [
  [1, 1, "元旦"],
  [2, 15, "春节"],
  [4, 4, "清明节"],
  [5, 1, "劳动节"],
  [6, 19, "端午节"],
  [9, 25, "中秋节"],
  [10, 1, "国庆节"]
];

// Next Chinese statutory holiday at/after `date` (00:00 local), in days.
function nextChineseHoliday(date) {
  const now = new Date(date.getTime());
  now.setHours(0, 0, 0, 0);
  const y = now.getFullYear();
  let best = null;
  for (let yy = y; yy <= y + 1; yy++) {
    for (const [m, d, name] of CN_HOLIDAYS) {
      const ts = new Date(yy, m - 1, d);
      if (ts < now) continue;
      const days = Math.round((ts - now) / 86400000);
      if (!best || days < best.days) best = { days, name, date: ts };
    }
  }
  return best;
}

function buildGreeting() {
  const now = new Date();
  const week = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  const pad = n => String(n).padStart(2, "0");
  const timeStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const h = now.getHours();
  const greet = h >= 5 && h < 11 ? "早上好" : h >= 11 && h < 13 ? "中午好" : h >= 13 && h < 18 ? "下午好" : "晚上好";
  const hol = nextChineseHoliday(now);
  const holStr = hol
    ? (hol.days === 0
        ? `🎉 今天就是「${hol.name}」（${hol.date.getMonth() + 1}月${hol.date.getDate()}日）`
        : `🗓 距离下一个法定节假日「${hol.name}」还有 ${hol.days} 天（${hol.date.getMonth() + 1}月${hol.date.getDate()}日）`)
    : "🗓 暂无后续法定节假日数据";
  return `${greet}！🤖 我上线了。\n\n📅 当前时间：${timeStr} 星期${week}\n${holStr}\n\n发「help」查看指令，或用自然语言让我干活～`;
}

// Send once per daemon process, right after WS READY.
let greetingSent = false;
function sendStartupGreeting() {
  if (!STARTUP_GREETING || greetingSent) return;
  greetingSent = true;
  const content = buildGreeting();
  for (const openid of AUTHPASS) {
    activeMessageToUser(openid, content).catch(e => log("GREETING ERROR " + e.message));
  }
}

// ---- read-only command execution ----------------------------------------
// Whitelist of safe commands. Each entry: prefix -> validator/executor.
// We ONLY run commands that are clearly read-only. The 3-arg execFile avoids
// any shell injection; we pass the raw command string as the single argument
// after a fixed binary. No shell, no metacharacter expansion.
const ALLOWED = new Set([
  "help", "ls", "dir", "pwd", "cwd", "ps", "tasklist", "ipconfig", "systeminfo",
  "whoami", "hostname", "ver", "date", "time", "echo", "shutdown", "关机"
]);

const DANGEROUS = /\b(del|erase|rmdir|rm|rd|format|shutdown|restart|reboot|reg\s+delete|kill|taskkill|move|copy|xcopy|ren|rename|mkdir|md|takeown|icacls|cipher|cacls|attrib|certutil|wevtutil|bcdedit|diskpart|vssadmin|format|mklink|remove|remove-item|clear|stop-process|stop-service|disable|uninstall|drop|truncate|write|set-content|add-content|out-file|>|<|>>|&&|\||;)\b/i;

function stripDangerous(s) {
  return DANGEROUS.test(s);
}

// ---- shutdown command (scheduled power-off, cancellable) ------------------
// 0 = no pending shutdown; >0 = epoch ms when the scheduled shutdown fires.
let pendingShutdownAt = 0;
const SHUTDOWN_DELAY_MS = 60000; // power off 60s after the command is received

function execFileAsync(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 15000, windowsHide: true }, (err, so, se) => {
      const text = ((so || "") + (se || "")).toString().trim();
      resolve({ ok: !err, text: text || (err ? err.message : "") });
    });
  });
}

function scheduleShutdown() {
  return execFileAsync("shutdown.exe", ["/s", "/t", String(Math.ceil(SHUTDOWN_DELAY_MS / 1000))]);
}

function cancelShutdown() {
  return execFileAsync("shutdown.exe", ["/a"]);
}

// ---- permission-request relay (approval/asked -> QQ -> stdin) -------------
// Set while the headless child is waiting on an approval decision. The next
// user message answers it (同意/允许 -> allow, 拒绝/取消 -> reject).
let pendingApprovalPid = null;
let pendingApprovalTimer = null;
// One-time network authorization: set while a likely-online task awaits the
// user's 允许/拒绝 answer. The approved task text falls through to the normal
// flow (split -> queue -> ack -> execute) on allow.
let pendingNetAsk = null; // { text, msgId, openid, timer }
// Interrupt selection dialog: awaiting the user's choice of which queued task
// to interrupt (number), 全部, 当前, or 取消. Timeout -> no operation.
let pendingInterrupt = null; // { timer }
// Batch permission grants: batchId -> { web, full }. A split batch whose parts
// all need the same permission gets ONE authorization that covers every
// instruction on the queue; mixed batches ask separately.
const batchGrants = new Map(); // batchId -> { web: bool, full: bool }
// Awaiting the user's authorization for a full-access batch (full-only or the
// full half of a mixed batch). Timeout -> drop the batch.
let pendingBatchFullAsk = null; // { batchId, parts, msgId, openid, timer }
// Reserved task slot: set synchronously the moment a task is committed to run
// (before any awaiting notification), cleared when the task finishes. Closes
// the race where a second message could pass the busy check while the first
// path is still awaiting before spawning.
let taskSlotBusy = false;
function reserveTaskSlot() { taskSlotBusy = true; }
// Queue of natural-language tasks submitted while another task is running.
// Entries run automatically (in order) after the current task completes.
// Each entry remembers the submitting user + msg_id so its replies (ack /
// progress / conclusion) are sent passively on that message.
let taskQueue = []; // [{ text, msgId, openid }]

function handleApprovalLine(detail) {
  const sp = detail.indexOf(" ");
  const pid = sp < 0 ? detail : detail.slice(0, sp);
  const info = sp < 0 ? "" : detail.slice(sp + 1);
  if (!pid) return;
  pendingApprovalPid = pid;
  log("APPROVAL requested pid=" + pid + " " + info.slice(0, 150));
  // Batch pre-authorization: if the running task belongs to a split batch
  // whose full-access was already approved once, auto-allow without asking.
  const grant = activeTask && activeTask.batchId ? batchGrants.get(activeTask.batchId) : null;
  if (grant && grant.full) {
    pendingApprovalPid = null;
    clearTimeout(pendingApprovalTimer);
    try { if (activeHeadless && activeHeadless.stdin) activeHeadless.stdin.write(`approval:allow:${pid}\n`); } catch (_) {}
    log("APPROVAL auto-allowed (batch full grant) pid=" + pid);
    for (const openid of AUTHPASS) {
      activeMessageToUser(openid, "✅ 本批任务已预先授权 full-access，已自动放行。").catch(() => {});
    }
    return;
  }
  // 15s countdown: timeout defaults to REJECT (no full-access transfer) and
  // the task continues under the workspace-write mode.
  clearTimeout(pendingApprovalTimer);
  pendingApprovalTimer = setTimeout(() => {
    if (pendingApprovalPid === pid && activeHeadless && !activeHeadless.killed) {
      log("APPROVAL timeout pid=" + pid + ", rejecting (no full access)");
      pendingApprovalPid = null;
      try { activeHeadless.stdin.write(`approval:reject:${pid}\n`); } catch (_) {}
      for (const openid of AUTHPASS) {
        activeMessageToUser(openid, "⏱ 权限授权等待超时(15 秒)，默认不转移到 full-access，任务将以工作区模式继续。").catch(() => {});
      }
    }
  }, CONFIRM_TIMEOUT_MS);
  const msg = "🔐 权限请求 · 全盘可写\n" + (info || "(未提供原因)") +
    "\n👉 回复「同意」= 转入全盘可写模式；「拒绝」= 维持工作区模式\n⏱ 15 秒内未回复默认拒绝。";
  for (const openid of AUTHPASS) {
    activeMessageToUser(openid, msg).catch(e => log("APPROVAL MSG ERROR " + e.message));
  }
}

function runCmd(cmd) {
  return new Promise(resolve => {
    // Collect raw bytes; native commands (ipconfig, systeminfo) emit GBK on
    // Chinese Windows regardless of console codepage settings, so decode
    // strictly as UTF-8 first and fall back to GBK for the whole output.
    const args = ["-NoProfile", "-NonInteractive", "-Command", cmd];
    const child = execFile("powershell.exe", args, {
      timeout: CMD_TIMEOUT,
      windowsHide: true,
      encoding: "buffer",
      maxBuffer: 1024 * 1024
    }, (err, stdoutBuf, stderrBuf) => {
      let out = "";
      const decode = (buf) => decodeAuto(buf);
      if (stdoutBuf && stdoutBuf.length) out += decode(stdoutBuf);
      if (stderrBuf && stderrBuf.length) out += decode(stderrBuf);
      if (err && !out) out = err.killed ? "[timeout] " : (err.message || String(err));
      resolve(out.trim() || "[no output]");
    });
  });
}

// UTF-8 strict decode first; on failure (replacement chars) decode as GBK
// (cp936, the ANSI codepage on Chinese Windows) which is what native tools emit.
function decodeAuto(buf) {
  const utf8 = Buffer.from(buf).toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(Buffer.from(buf));
  } catch (_) {
    return utf8;
  }
}

// Run a fresh DSH headless agent session on the given task text and return
// the agent's final conclusion (stdout). Uses the default workspace and the
// standard preset with workspace-write permissions.
// onProgress(elapsedSec) is called periodically while the agent runs.
//
// DSH_BIN: the dsh CLI entry. Defaults to the globally installed dsh; the
// config can override it via "dshBin". If the config path does not exist, fall
// back to resolving "dsh" on PATH.
const DSH_BIN = (() => {
  const fromConfig = config.dshBin;
  if (fromConfig && fs.existsSync(fromConfig)) return fromConfig;
  // Derive the npm global dsh CLI from the current user's home dir so the code
  // carries no machine-specific username.
  try {
    const os = require("os");
    const npmGlobal = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
    if (fs.existsSync(npmGlobal)) return npmGlobal;
  } catch (_) {}
  return "dsh"; // let PATH resolve it
})();
const HEADLESS_TIMEOUT = 300000; // 5 min cap for a full agent run
// Progress pushes are throttled to at most one per PROGRESS_INTERVAL
// (configurable via "progressIntervalMs"; default 60s, was a fixed 8s).
// Users can always get an immediate update by sending a progress-query word
// (e.g. 进度) while a task is running.
const PROGRESS_INTERVAL = config.progressIntervalMs || 60000;

// The currently running headless child process, so an interrupt command can
// kill it. Only one headless task may run at a time.
let activeHeadless = null;
// State of the currently running headless task, used for on-demand progress
// pushes when the user messages the bot while a task is running.
let activeTask = null; // { text, startedAt, lastStep }
// Timestamp of the last push (ack or progress); progress pushes are throttled
// to at most one per PROGRESS_INTERVAL.
let lastProgressAt = 0;

// Progress-query words: while a task is running, these get an immediate
// on-demand progress push instead of starting a new session.
const PROGRESS_QUERY_WORDS = ["进度", "进展", "进行到哪", "还在吗", "查询进度", "进度查询", "status", "progress"];
function isProgressQuery(cmd) {
  const t = cmd.trim().toLowerCase();
  return PROGRESS_QUERY_WORDS.some(w => t.includes(w));
}

function queueStatus() {
  const parts = [];
  if (activeTask) {
    const secs = Math.round((Date.now() - activeTask.startedAt) / 1000);
    const last = activeTask.lastStep ? "\n最近步骤: " + activeTask.lastStep.slice(0, 100) : "";
    parts.push("⏳ 当前任务:「" + activeTask.text.slice(0, 40) + "」,已运行 " + secs + " 秒。" + last);
  } else {
    parts.push("当前没有正在运行的任务。");
  }
  if (taskQueue.length > 0) {
    parts.push("📥 队列中还有 " + taskQueue.length + " 个任务:");
    taskQueue.forEach((q, i) => { parts.push("  " + (i + 1) + ". " + String(q.text).slice(0, 50)); });
  } else {
    parts.push("📥 队列为空。");
  }
  return parts.join("\n");
}

// Build a throttled progress sender for one message channel. Used both for
// direct tasks (handleEvent) and for queued tasks (drainTaskQueue).
function makeProgressSender(openid, msgId) {
  return async (p) => {
    try {
      const now = Date.now();
      if (now - lastProgressAt < PROGRESS_INTERVAL) return; // throttled
      // Claim the throttle window BEFORE the async send: the check and this
      // assignment are synchronous, so concurrent onProgress calls (multiple
      // [STEP] events + the tick firing together) can no longer all pass the
      // check while the first reply is still in flight (which previously
      // caused bursts of 2-5 duplicate progress pushes every 60s).
      lastProgressAt = now;
      let note;
      if (p && p.kind === "step") {
        const text = String(p.text || "").slice(0, 120);
        // Never push raw thinking / generic start notices to the user; only
        // actionable steps (tool calls) are worth a progress message.
        if (/^(推理|开始处理)/.test(text)) return;
        note = "⚙️ " + (text || "正在执行…");
      } else {
        const secs = p && p.secs ? p.secs : Math.round((now - lastProgressAt) / 1000);
        note = "⏳ 仍在处理中…(已运行 " + secs + " 秒,发「进度」可查询详情)";
      }
      await replyToUser(openid, msgId, note, nextMsgSeq(msgId));
    } catch (e) {
      log("PROGRESS REPLY ERROR " + e.message);
    }
  };
}

// Auto-split a single message that contains multiple instructions joined by
// connectors (然后/接着/接下来/随后/之后/并且/还有/再然后…), where each part
// stands alone as a task. The connector must follow punctuation or whitespace
// and every part must be at least 3 chars, to avoid false splits. ("同时" is
// deliberately excluded: it is too often part of the same sentence.)
function splitInstructions(text) {
  const parts = text
    .split(/(?<=[，。；,;.!！?\s])\s*(?:然后|接着|接下来|随后|之后|并且|还有|再然后)\s*/)
    .map(s => s.trim().replace(/^[，。；,;.!！?\s]+/, "").replace(/[，。；,;.!！?\s]+$/, ""))
    .filter(s => s.length >= 3);
  return parts.length >= 2 ? parts : [text];
}

// Run queued tasks one by one after the current task finishes. Uses each
// entry's original msg_id for passive replies (ack / progress / conclusion).
async function drainTaskQueue() {
  while (taskQueue.length > 0) {
    if (taskSlotBusy || (activeHeadless && !activeHeadless.killed)) return; // another task is running
    const entry = taskQueue.shift();
    if (!entry || !entry.text) continue;
    const openid = entry.openid;
    const msgId = entry.msgId;
    try {
      const ackQ = "✅ 开始执行队列任务:「" + entry.text.slice(0, 40) + "」…";
      await replyToUser(openid, msgId, ackQ, nextMsgSeq(msgId));
      lastProgressAt = Date.now();
    } catch (e) {
      log("QUEUE ACK ERROR " + e.message);
    }
    const result = await runHeadlessSession(entry.text, makeProgressSender(openid, msgId), entry.batchId);
    try {
      await replyToUserBatched(openid, msgId, result);
    } catch (e) {
      log("QUEUE REPLY ERROR " + e.message);
    }
  }
}

function runHeadlessSession(task, onProgress, batchId) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    reserveTaskSlot();
    // Track task state for on-demand progress queries while it runs.
    activeTask = { text: task, startedAt, lastStep: "", batchId: batchId || null };
    // Every natural-language task runs inside the configured workspace. The
    // headless runner uses process.cwd() as the agent workspace, so spawning
    // dsh with this cwd directs the whole conversation to that directory.
    const ws = WORKSPACE;
    try { fs.mkdirSync(ws, { recursive: true }); } catch (_) {}
    log("HEADLESS task=" + JSON.stringify(task.slice(0, 120)) + " workspace=" + ws);
    // Fallback heartbeat (only when no [STEP] lines arrive). [STEP] lines
    // streamed by the patched headless carry real steps; we prefer those.
    const progressTimer = setInterval(() => {
      if (onProgress) {
        try { onProgress({ kind: "tick", secs: Math.round((Date.now() - startedAt) / 1000) }); } catch (_) {}
      }
    }, PROGRESS_INTERVAL);

    const args = [DSH_BIN, "--profile", "headless", task];
    const child = spawn(process.execPath, args, {
      cwd: ws,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"] // stdin: approval decisions from the user
    });
    activeHeadless = child;

    let out = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(progressTimer);
      if (activeHeadless === child) activeHeadless = null;
      taskSlotBusy = false;
      if (activeTask && activeTask.startedAt === startedAt) activeTask = null;
      if (pendingApprovalPid) { pendingApprovalPid = null; clearTimeout(pendingApprovalTimer); }
      if (pendingInterrupt) { clearTimeout(pendingInterrupt.timer); pendingInterrupt = null; }
      // Drop the batch grant once no queued task of that batch remains.
      if (activeTask && activeTask.batchId && !taskQueue.some(q => q.batchId === activeTask.batchId)) {
        batchGrants.delete(activeTask.batchId);
      }
      resolve(out.trim() || "[agent 未返回结论]");
      // Automatically run the next queued task after this one completes.
      drainTaskQueue().catch(e => log("QUEUE DRAIN ERROR " + e.message));
    };

    // Accumulate non-STEP stdout/stderr (the final conclusion). [STEP] lines
    // are real intermediate steps -> forward to onProgress as live updates
    // and strip them from the accumulated output so the final reply is the
    // agent's conclusion only. [APPROVAL] lines are permission requests.
    let stepAccum = "";
    const handleChunk = (c) => {
      const s = c.toString("utf8");
      stepAccum += s;
      const lines = stepAccum.split("\n");
      stepAccum = lines.pop(); // keep partial last line
      for (const ln of lines) {
        const am = ln.match(/^\[APPROVAL\]\s*(.*)$/);
        if (am) {
          handleApprovalLine(am[1]);
          continue;
        }
        const m = ln.match(/^\[STEP\]\s*(.*)$/);
        if (m && onProgress) {
          // Record only actionable steps (tool calls) for progress queries;
          // raw thinking/reasoning is skipped per user preference.
          if (activeTask && !m[1].trim().startsWith("推理")) activeTask.lastStep = m[1].trim();
          try { onProgress({ kind: "step", text: m[1].trim() }); } catch (_) {}
        } else if (ln.trim()) {
          out += ln + "\n";
        }
      }
    };
    child.stdout.on("data", handleChunk);
    child.stderr.on("data", c => { out += c.toString("utf8"); });

    const killTimer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch (_) {}
    }, HEADLESS_TIMEOUT);

    child.on("error", err => {
      clearTimeout(killTimer);
      if (!out.trim()) out = "[headless 会话失败] " + (err.message || String(err));
      finish();
    });

    child.on("close", (code, signal) => {
      clearTimeout(killTimer);
      if (code === null || signal) {
        if (!out.trim()) out = "[已中断]";
        else out = "[已中断] " + out.trim();
      }
      finish();
    });
  });
}

// Interrupt words: telling the daemon to abort the running headless turn.
// These are matched first (before whitelist / danger checks) so they never
// spawn a new session.
const INTERRUPT_WORDS = new Set(["中断", "取消", "停止", "stop", "cancel", "abort", "halt"]);
// QQ quick-command panel sends slash-prefixed commands (e.g. "/help"); strip
// leading "/" so they match the same whitelist as their bare form.
function normalizeSlash(s) {
  const t = s.trim();
  return t.replace(/^\/+/, "").trimStart();
}
function isInterrupt(cmd) {
  const t = normalizeSlash(cmd).toLowerCase();
  return INTERRUPT_WORDS.has(t) || INTERRUPT_WORDS.has(t.replace(/[。.!！]/g, ""));
}

function isAllowed(cmd) {
  const first = normalizeSlash(cmd).split(/\s+/)[0].toLowerCase();
  return ALLOWED.has(first);
}

async function execute(cmd, onProgress, opts) {
  const trimmed = cmd.trim();
  const normalized = normalizeSlash(trimmed); // quick-panel "/cmd" behaves as "cmd"
  if (!normalized) return "[empty]";

  // Interrupt command: cancel a pending shutdown, clear the task queue, and/or
  // kill the running headless task. Never starts a new session.
  if (isInterrupt(normalized)) {
    const msgs = [];
    if (taskQueue.length > 0) {
      const n = taskQueue.length;
      taskQueue = [];
      msgs.push("✅ 已清空任务队列(" + n + " 个待执行任务已取消)。");
    }
    if (pendingShutdownAt > 0) {
      pendingShutdownAt = 0;
      const r = await cancelShutdown();
      msgs.push(r.ok ? "✅ 已取消关机。" : "❌ 关机取消失败(" + r.text + ")，可能已进入关机流程。");
    }
    if (activeHeadless && !activeHeadless.killed) {
      try { activeHeadless.kill("SIGTERM"); } catch (_) {}
      // Give it a moment then force if needed
      setTimeout(() => {
        if (activeHeadless && !activeHeadless.killed) { try { activeHeadless.kill("SIGKILL"); } catch (_) {} }
      }, 1500);
      msgs.push("✅ 已中断当前正在运行的任务。");
    }
    if (!msgs.length) return "当前没有正在运行的任务，也没有待执行的关机。";
    return msgs.join("\n");
  }

  // While a task is running, natural-language messages are QUEUED (no second
  // concurrent session). Progress queries still get an immediate on-demand
  // push with the current progress + the queued tasks. opts.skipBusy lets a
  // split batch's first part run immediately (its siblings are already queued).
  if (!(opts && opts.skipBusy) && (taskSlotBusy || (activeHeadless && !activeHeadless.killed) || taskQueue.length > 0)) {
    if (isProgressQuery(normalized)) return queueStatus();
    if (!isWhitelistCommand(normalized)) {
      taskQueue.push({ text: trimmed, msgId: "", openid: "" });
      return "📥 已加入任务队列(第 " + taskQueue.length + " 位):「" + trimmed.slice(0, 40) + "」\n当前任务完成后将自动执行。发「进度」可查看当前进度与队列。";
    }
  }

  const first = normalized.split(/\s+/)[0].toLowerCase();
  if (first === "help") {
    const L = "━━━━━━━━━━━━━━━━━━";
    return [
      "🤖 QQ 远程控制 · 指令菜单",
      L,
      "📂 目录与信息",
      "  ls / dir       列目录(例: ls C:\\)",
      "  pwd / cwd      当前工作目录",
      "  echo <词>      回显文字",
      L,
      "🖥 进程与系统",
      "  ps / tasklist  进程列表",
      "  ipconfig       网络配置",
      "  systeminfo     系统信息",
      "  whoami         当前用户",
      "  hostname       主机名",
      "  ver            系统版本",
      "  date / time    日期 / 时间",
      L,
      "💬 智能任务",
      "  任意自然语言   转交 AI agent 处理",
      "  进度           当前任务进度 + 队列",
      "  中断 / 取消    终止任务(确认式) / 取消关机",
      "  以 / 开头同样有效(快捷面板): /help /ls /ps 等",
      L,
      "💻 系统控制",
      "  shutdown / 关机  60 秒后关机(可取消)",
      L,
      "🔐 权限",
      "  联网 / 全盘任务需授权，15 秒未回复默认拒绝"
    ].join("\n");
  }
  if (first === "shutdown" || normalized === "关机") {
    if (normalized !== "shutdown" && normalized !== "关机") {
      return "仅支持「shutdown」或「关机」(60 秒后关机)。不接受其它参数。";
    }
    if (pendingShutdownAt > 0) {
      const left = Math.max(1, Math.ceil((pendingShutdownAt - Date.now()) / 1000));
      return "已有关机计划(约 " + left + " 秒后关机)。发「中断 / 取消」可取消。";
    }
    const r = await scheduleShutdown();
    if (!r.ok) return "❌ 关机调度失败: " + r.text;
    pendingShutdownAt = Date.now() + SHUTDOWN_DELAY_MS;
    return "🛑 将在 60 秒后关机。发送「中断 / 取消 / stop」可取消本次关机。";
  }
  if (isAllowed(normalized)) {
    if (stripDangerous(normalized)) {
      return "[拒绝] 检测到危险关键字，已阻止执行。";
    }
    const out = await runCmd(normalized);
    return out;
  }
  // Non-whitelist explicit text -> delegate to a fresh DSH headless session
  // (standard preset, workspace-write, default workspace). The daemon runs
  // outside the DSH sandbox (started by Startup), so spawning dsh works here.
  return runHeadlessSession(trimmed, onProgress, opts && opts.batchId);
}

// Batch a long reply into multiple passive messages on the same msg_id
// (increasing msg_seq), instead of truncating it to one message. At most
// BATCH_MAX_CHUNKS chunks of ~REPLY_LIMIT chars each; anything beyond is
// summarized with an omission note.
const BATCH_MAX_CHUNKS = 6;

// URL matcher: http(s) URLs (optionally a trailing ')' for markdown links).
const URL_SPLIT_RE = /https?:\/\/[^\s)\]"}<>]+\)?/g;

// Split long content into chunks without cutting a URL (or a UTF-16 surrogate
// pair, i.e. emoji) at the boundary. When the boundary would split a URL, the
// cut moves after the URL end; if the URL starts close to the chunk beginning,
// the cut moves before the URL instead so the URL lands intact in the next
// chunk.
function splitRespectingUrls(content, limit) {
  const chunks = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + limit, content.length);
    if (end < content.length) {
      // Never split a surrogate pair (emoji) at the boundary.
      const hi = content.charCodeAt(end - 1);
      if (hi >= 0xD800 && hi <= 0xDBFF && end < content.length) end += 1;
      // Never split a URL at the boundary.
      URL_SPLIT_RE.lastIndex = 0;
      let m;
      while ((m = URL_SPLIT_RE.exec(content)) !== null) {
        const urlStart = m.index;
        const urlEnd = m.index + m[0].length;
        if (urlStart < end && urlEnd > end) {
          let adjust = urlEnd;
          if (urlStart - start < Math.floor(limit / 2)) adjust = Math.max(start, urlStart);
          if (adjust > start) end = adjust;
          break;
        }
      }
    }
    chunks.push(content.slice(start, end));
    start = end;
  }
  return chunks;
}

async function replyToUserBatched(openid, msgId, content) {
  if (!content) return;
  let chunks = splitRespectingUrls(content, REPLY_LIMIT);
  if (chunks.length > BATCH_MAX_CHUNKS) {
    const keptLen = chunks.slice(0, BATCH_MAX_CHUNKS).reduce((a, c) => a + c.length, 0);
    chunks = chunks.slice(0, BATCH_MAX_CHUNKS);
    chunks[chunks.length - 1] += "\n...[其余 " + (content.length - keptLen) + " 字符已省略]";
  }
  for (let k = 0; k < chunks.length; k++) {
    await replyToUser(openid, msgId, chunks[k], nextMsgSeq(msgId));
    if (k < chunks.length - 1) await new Promise(r => setTimeout(r, 250));
  }
}

// ---- websocket lifecycle -------------------------------------------------
let ws = null;
let heartbeatTimer = null;
let lastSeq = null;
let sessionId = null;
let reconnecting = false;

function startHeartbeat(interval) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ op: 1, d: lastSeq }));
    }
  }, interval);
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function parseMsgId(d) {
  if (d && typeof d.id === "string") return d.id;
  return null;
}

// Decode a websocket message payload to a UTF-8 string, regardless of the
// frame type (string / ArrayBuffer / Blob). String(ev.data) on a binary
// frame decodes as Latin-1 and garbles CJK text.
async function decodeData(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof Blob !== "undefined" && data instanceof Blob) return await data.text();
  return String(data);
}

// True when the text is a whitelisted read-only command answered directly by
// the daemon (including "help"). Everything else is delegated to a headless
// agent session.
function isWhitelistCommand(cmd) {
  const first = normalizeSlash(cmd).split(/\s+/)[0].toLowerCase();
  return first === "help" || ALLOWED.has(first);
}

async function handleEvent(d, t) {
  const author = d && d.author ? d.author : {};
  const openid = author.user_openid || author.id;
  if (!openid || !AUTHPASS.has(openid)) {
    log("IGNORED from non-authorized openid=" + openid + " event=" + t);
    return;
  }
  let content = (d && d.content) || "";
  const msgId = parseMsgId(d);
  if (!msgId) {
    log("IGNORED no msg_id, openid=" + openid);
    return;
  }
  log(`CMD openid=${openid} content=` + JSON.stringify(content));

  // While an approval request is pending, the next user message answers it
  // (before anything else: no ack, no new session, no interrupt handling).
  if (pendingApprovalPid && activeHeadless && !activeHeadless.killed) {
    const t = normalizeSlash(content).toLowerCase();
    const allow = /^(同意|允许|可以|批准|确认|ok|yes|是|好)$/i.test(t) || /^(同意|允许|可以|批准|确认)/.test(t);
    const reject = /^(拒绝|不同意|不行|取消|中断|stop|cancel|abort|no|否|否决|不要)$/i.test(t) || /^(拒绝|不同意|否决)/.test(t);
    let reply;
    if (allow || reject) {
      const pid = pendingApprovalPid;
      pendingApprovalPid = null;
      clearTimeout(pendingApprovalTimer);
      try {
        if (activeHeadless.stdin) activeHeadless.stdin.write(`approval:${allow ? "allow" : "reject"}:${pid}\n`);
      } catch (e) {
        log("APPROVAL STDIN ERROR " + e.message);
      }
      reply = allow
        ? "✅ 已授权：本次任务将以全盘可写模式继续。"
        : "❌ 已拒绝：任务继续以工作区模式运行。";
      log("APPROVAL answered allow=" + allow + " pid=" + pid);
    } else {
      reply = "当前有待确认的权限请求。请回复「同意」或「拒绝」。";
    }
    try { await replyToUser(openid, msgId, reply, nextMsgSeq(msgId)); } catch (e) { log("APPROVAL REPLY ERROR " + e.message); }
    return;
  }

  // ---- one-time network authorization (联网先询问) --------------------------
  // A task that looks like it needs the network asks the user first. The
  // approved task text falls through to the normal flow below (split -> queue
  // -> ack -> execute) exactly once.
  let netApproved = false;
  if (pendingNetAsk) {
    const t = normalizeSlash(content).toLowerCase();
    const allow = /^(允许|同意|可以|是|好|ok|yes)$/i.test(t) || /^(允许|同意|可以|是)/.test(t);
    const deny = /^(拒绝|不用|不要|否|取消|不行|中断|stop|cancel|abort|no)$/i.test(t) || /^(拒绝|不用|否|取消|中断)/.test(t);
    if (allow || deny) {
      const entry = pendingNetAsk;
      pendingNetAsk = null;
      clearTimeout(entry.timer);
      if (allow) {
        netApproved = true;
        content = entry.text; // proceed: split/queue/ack/execute below
        log("NETASK allowed, executing: " + entry.text.slice(0, 60));
      } else {
        try { await replyToUser(openid, msgId, "已拒绝本次联网授权，任务未执行。如需其它操作请重新发送。", nextMsgSeq(msgId)); } catch (e) { log("REPLY ERROR " + e.message); }
        return;
      }
    } else {
      try { await replyToUser(openid, msgId, "当前有待确认的联网授权请求。请回复「允许」联网执行，或「拒绝」不执行。", nextMsgSeq(msgId)); } catch (e) { log("REPLY ERROR " + e.message); }
      return;
    }
  }
  // ---- interrupt confirmation ANSWER ---------------------------------------
  // The interrupt-selection menu awaits one answer: a queue number, 全部, 当前,
  // 确认, or 取消. This must run BEFORE the isInterrupt() gate below: menu
  // answers like 全部/当前/确认 are not themselves interrupt words, so gating
  // the consumption on isInterrupt() let them fall through and get enqueued
  // as tasks (and the menu then timed out with no operation).
  if (pendingInterrupt) {
    const t = normalizeSlash(content).toLowerCase();
    clearTimeout(pendingInterrupt.timer);
    pendingInterrupt = null;
    const num = /^(\d+)$/.exec(t);
    const all = /^(全部|所有|全|all)$/i.test(t);
    const cur = /^(当前|现在|本次)$/i.test(t);
    const confirm = /^(确认|是|确定|yes|ok)$/i.test(t);
    const cancel = /^(取消|否|放弃|算了|no)$/i.test(t) || t.startsWith("取消");
    let reply;
    if (num) {
      const idx = Number(num[1]) - 1;
      if (idx >= 0 && idx < taskQueue.length) {
        const removed = taskQueue.splice(idx, 1)[0];
        reply = "✅ 已从队列移除第 " + num[1] + " 项：「" + String(removed.text).slice(0, 40) + "」\n当前任务继续运行。";
      } else {
        reply = "❌ 序号超出范围(队列共 " + taskQueue.length + " 项)。";
      }
    } else if (all) {
      const n = taskQueue.length;
      taskQueue = [];
      if (activeHeadless && !activeHeadless.killed) {
        try { activeHeadless.kill("SIGTERM"); } catch (_) {}
        setTimeout(() => { if (activeHeadless && !activeHeadless.killed) { try { activeHeadless.kill("SIGKILL"); } catch (_) {} } }, 1500);
      }
      reply = "✅ 已终止全部任务(队列 " + n + " 项 + 当前任务)。";
    } else if (cur) {
      if (activeHeadless && !activeHeadless.killed) {
        try { activeHeadless.kill("SIGTERM"); } catch (_) {}
        setTimeout(() => { if (activeHeadless && !activeHeadless.killed) { try { activeHeadless.kill("SIGKILL"); } catch (_) {} } }, 1500);
      }
      reply = "✅ 已中断当前任务，队列保留。";
    } else if (confirm && taskQueue.length === 0) {
      // no queue: plain "确认" interrupts the current task
      if (activeHeadless && !activeHeadless.killed) {
        try { activeHeadless.kill("SIGTERM"); } catch (_) {}
        setTimeout(() => { if (activeHeadless && !activeHeadless.killed) { try { activeHeadless.kill("SIGKILL"); } catch (_) {} } }, 1500);
      }
      reply = "✅ 已中断当前正在运行的任务。";
    } else if (cancel) {
      reply = "已取消中断操作，当前任务与队列均不受影响。";
    } else {
      pendingInterrupt = { timer: setTimeout(() => {
        if (pendingInterrupt) {
          pendingInterrupt = null;
          for (const openid2 of AUTHPASS) {
            activeMessageToUser(openid2, "⏱ 中断确认等待超时(15 秒)，默认不中断任何任务，当前任务继续运行。").catch(() => {});
          }
        }
      }, CONFIRM_TIMEOUT_MS) };
      reply = "请回复队列序号(1-" + taskQueue.length + ")、「全部」「当前」或「取消」。";
    }
    try { await replyToUser(openid, msgId, reply, nextMsgSeq(msgId)); } catch (e) { log("INTERRUPT REPLY ERROR " + e.message); }
    return;
  }

  if (NET_ASK && !netApproved && !isWhitelistCommand(content) && !isInterrupt(content) && !isProgressQuery(content) && NET_TASK_RE.test(content)) {
    // Only list the instructions that actually need network access.
    const parts = splitInstructions(content);
    const webItems = parts.length > 1 ? parts.filter(p => NET_TASK_RE.test(p)) : [content];
    // 15s countdown: timeout defaults to NO authorization — the task is
    // neither executed nor queued, and the user is told so.
    const timer = setTimeout(() => {
      if (pendingNetAsk && pendingNetAsk.text === content) {
        pendingNetAsk = null;
        log("NETASK timeout, task not executed: " + content.slice(0, 60));
        for (const openid2 of AUTHPASS) {
          activeMessageToUser(openid2, "⏱ 联网授权等待超时(15 秒)，默认不授权联网，该任务未执行且未加入队列。").catch(() => {});
        }
      }
    }, CONFIRM_TIMEOUT_MS);
    pendingNetAsk = { text: content, msgId, openid, timer };
    const askMsg = buildPermPrompt("联网", webItems, "= 联网执行", "= 不执行");
    try { await replyToUser(openid, msgId, askMsg, nextMsgSeq(msgId)); } catch (e) { log("NETASK REPLY ERROR " + e.message); }
    return;
  }

  // ---- batch full-access authorization -------------------------------------
  // Consumed BEFORE the interrupt gate below: the answer 取消/拒绝 is also an
  // interrupt word and must answer this pending prompt, not open a new
  // interrupt dialog. A split batch whose parts all need full-access is
  // authorized ONCE for the whole queue; a mixed batch asks separately.
  let splitNotified = false;
  // True when a split batch's FIRST part should run immediately (its siblings
  // are already queued) — skips the busy/queue checks that would re-queue it.
  let firstPartRuns = false;
  // batchId of the first part when it runs immediately (keeps its batch grant).
  let batchFirstId = null;
  if (pendingBatchFullAsk) {
    const t = normalizeSlash(content).toLowerCase();
    const allow = /^(允许|同意|可以|是|好|ok|yes)$/i.test(t) || /^(允许|同意|可以|是)/.test(t);
    const deny = /^(拒绝|不用|不要|否|取消|不行|no)$/i.test(t) || /^(拒绝|不用|否|取消)/.test(t);
    if (allow || deny) {
      const entry = pendingBatchFullAsk;
      pendingBatchFullAsk = null;
      clearTimeout(entry.timer);
      if (!allow) {
        batchGrants.delete(entry.batchId);
        try { await replyToUser(openid, msgId, "已拒绝本批 full-access 授权，本批任务未执行。", nextMsgSeq(msgId)); } catch (e) { log("BATCH REPLY ERROR " + e.message); }
        return;
      }
      const g = batchGrants.get(entry.batchId); if (g) g.full = true;
      log("BATCH full-access granted: " + entry.batchId);
      const list = entry.parts.map((p, i) => "  " + (i + 1) + ". " + p.slice(0, 50)).join("\n");
      const busyNow = (activeHeadless && !activeHeadless.killed) || taskQueue.length > 0;
      if (busyNow) {
        for (const p of entry.parts) taskQueue.push({ text: p, msgId: entry.msgId, openid: entry.openid, batchId: entry.batchId });
        try { await replyToUser(openid, msgId, "✅ 已授权本批 full-access，全部加入队列：\n" + list + "\n当前任务完成后将按序自动执行。", nextMsgSeq(msgId)); } catch (e) { log("BATCH REPLY ERROR " + e.message); }
        return;
      }
      for (let i = 1; i < entry.parts.length; i++) taskQueue.push({ text: entry.parts[i], msgId: entry.msgId, openid: entry.openid, batchId: entry.batchId });
      batchFirstId = entry.batchId;
      reserveTaskSlot(); // commit before the awaiting notification
      try { await replyToUser(openid, msgId, "✅ 已授权本批 full-access，开始执行第 1 个：\n" + list + "\n其余已加入队列，将依次执行。", nextMsgSeq(msgId)); } catch (e) { log("BATCH REPLY ERROR " + e.message); }
      content = entry.parts[0];
      splitNotified = true;
      firstPartRuns = true;
    } else {
      try { await replyToUser(openid, msgId, "当前有待确认的本批权限请求。请回复「允许」或「拒绝」。", nextMsgSeq(msgId)); } catch (e) { log("BATCH REPLY ERROR " + e.message); }
      return;
    }
  }

  // ---- bare control words (no pending dialog) ------------------------------
  // 全部/当前/确认 etc. sent outside any confirmation dialog are dialog
  // answers, not tasks: never spawn or queue a headless session for them.
  if (/^(全部|所有|全|当前|现在|本次|确认|确定|all|current|confirm)$/i.test(normalizeSlash(content))) {
    try { await replyToUser(openid, msgId, "当前没有待确认的中断/权限请求。如需中断任务，请发送「中断」或「stop」。", nextMsgSeq(msgId)); } catch (e) { log("CONTROL REPLY ERROR " + e.message); }
    return;
  }

  // ---- interrupt confirmation: which queued task / all / current ----------
  // (Menu answers are consumed above, before this gate.) A new 中断 request
  // cancels a pending shutdown immediately (safe cancel action), then presents
  // the task-interrupt selection dialog. 15s timeout = no operation.
  if (isInterrupt(content)) {
    // new interrupt request: cancel a pending shutdown immediately (safe
    // cancel action), then present the task-interrupt selection dialog.
    let sdMsg = "";
    if (pendingShutdownAt > 0) {
      pendingShutdownAt = 0;
      const r = await cancelShutdown();
      sdMsg = r.ok ? "✅ 已取消关机。\n" : "❌ 关机取消失败(" + r.text + ")。\n";
    }
    if ((activeHeadless && !activeHeadless.killed) || taskQueue.length > 0) {
      let msg;
      if (taskQueue.length > 0) {
        const list = taskQueue.map((q, i) => "  " + (i + 1) + ". " + String(q.text).slice(0, 50)).join("\n");
        msg = sdMsg + "🛑 当前有 " + taskQueue.length + " 个任务在队列中：\n" + list +
          "\n回复「序号」= 中断对应队列任务；「全部」= 终止全部(含当前)；「当前」= 仅中断当前任务；「取消」= 放弃。\n15 秒内未回复默认不操作。";
      } else {
        msg = sdMsg + "🛑 是否中断当前正在运行的任务？\n回复「确认 / 是」= 中断；「取消」= 继续。\n15 秒内未回复默认不中断。";
      }
      pendingInterrupt = { timer: setTimeout(() => {
        if (pendingInterrupt) {
          pendingInterrupt = null;
          for (const openid2 of AUTHPASS) {
            activeMessageToUser(openid2, "⏱ 中断确认等待超时(15 秒)，默认不中断任何任务，当前任务继续运行。").catch(() => {});
          }
        }
      }, CONFIRM_TIMEOUT_MS) };
      try { await replyToUser(openid, msgId, msg, nextMsgSeq(msgId)); } catch (e) { log("INTERRUPT REPLY ERROR " + e.message); }
      return;
    }
    try { await replyToUser(openid, msgId, sdMsg + "当前没有正在运行的任务，也没有待执行的队列。", nextMsgSeq(msgId)); } catch (e) { log("INTERRUPT REPLY ERROR " + e.message); }
    return;
  }

  if (AUTO_SPLIT && !isWhitelistCommand(content) && !isInterrupt(content) && !isProgressQuery(content)) {
    const parts = splitInstructions(content);
    if (parts.length > 1) {
      const batchId = "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const needs = classifyBatch(parts);
      batchGrants.set(batchId, { web: netApproved, full: false });
      // Full-access batch gate: same permission for the whole batch -> ONE ask.
      if (needs.full && !batchGrants.get(batchId).full) {
        // Only list the instructions that actually need full-disk access.
        const fullItems = parts.filter(p => FULL_TASK_RE.test(p));
        const timer = setTimeout(() => {
          if (pendingBatchFullAsk && pendingBatchFullAsk.batchId === batchId) {
            pendingBatchFullAsk = null;
            batchGrants.delete(batchId);
            for (const o of AUTHPASS) {
              activeMessageToUser(o, "⏱ 本批权限授权等待超时(15 秒)，默认拒绝，本批任务未执行且未加入队列。").catch(() => {});
            }
          }
        }, CONFIRM_TIMEOUT_MS);
        pendingBatchFullAsk = { batchId, parts, msgId, openid, timer };
        const askMsg = buildPermPrompt("全盘可写", fullItems, "= 本批全部授权", "= 本批不执行");
        try { await replyToUser(openid, msgId, askMsg, nextMsgSeq(msgId)); } catch (e) { log("BATCH ASK ERROR " + e.message); }
        return;
      }
      const busyNow = (activeHeadless && !activeHeadless.killed) || taskQueue.length > 0;
      const list = parts.map((p, i) => "  " + (i + 1) + ". " + p.slice(0, 50)).join("\n");
      if (busyNow) {
        for (const part of parts) taskQueue.push({ text: part, msgId, openid, batchId });
        const reply = "📚 检测到 " + parts.length + " 个指令，已全部加入队列：\n" + list +
          "\n当前任务完成后将按序自动执行。发「进度」可查看队列。";
        try { await replyToUser(openid, msgId, reply, nextMsgSeq(msgId)); } catch (e) { log("QUEUE REPLY ERROR " + e.message); }
        return;
      }
      for (let i = 1; i < parts.length; i++) taskQueue.push({ text: parts[i], msgId, openid, batchId });
      batchFirstId = batchId;
      reserveTaskSlot(); // commit before the awaiting notification
      const reply = "📚 检测到 " + parts.length + " 个指令，已自动拆分：\n" + list +
        "\n现在开始执行第 1 个，其余已加入队列，将依次执行。";
      try { await replyToUser(openid, msgId, reply, nextMsgSeq(msgId)); } catch (e) { log("QUEUE REPLY ERROR " + e.message); }
      splitNotified = true;
      content = parts[0];
      firstPartRuns = true;
    }
  }

  // Queue natural-language messages received while a task is running (or the
  // queue is non-empty): no ack, no second concurrent session — they run in
  // order after the current task finishes (see drainTaskQueue). A split
  // batch's first part is exempt (firstPartRuns).
  const busy = !firstPartRuns && (taskSlotBusy || (activeHeadless && !activeHeadless.killed) || taskQueue.length > 0);
  if (busy && !isWhitelistCommand(content) && !isInterrupt(content) && !isProgressQuery(content)) {
    taskQueue.push({ text: content, msgId, openid });
    const reply = "📥 已加入任务队列(第 " + taskQueue.length + " 位):「" + content.slice(0, 40) + "」\n当前任务完成后将自动执行。发「进度」可查看当前进度与队列。";
    try { await replyToUser(openid, msgId, reply, nextMsgSeq(msgId)); } catch (e) { log("QUEUE REPLY ERROR " + e.message); }
    return;
  }

  // Only acknowledge when a new headless session will actually be started:
  // progress queries and busy-notice messages (a task is already running and
  // this message won't spawn a session) must NOT get the "starting a new
  // session" ack — they get their direct reply from execute() instead.
  const startsNewSession = !isWhitelistCommand(content) && !isInterrupt(content) &&
    !isProgressQuery(content) && !busy;
  if (startsNewSession && !splitNotified) {
    reserveTaskSlot(); // commit before the awaiting ack (closes the spawn race)
    try {
      const ack = "✅ 已收到，正在新建会话处理你的请求，请稍候…\n（发「进度」可随时查询进展，「中断」可停止）";
      await replyToUser(openid, msgId, ack, nextMsgSeq(msgId));
      lastProgressAt = Date.now();
    } catch (e) {
      log("ACK REPLY ERROR " + e.message);
    }
  }

  // Live progress updates while the agent runs, sent on the same msg_id with
  // increasing msg_seq. Real steps (from [STEP] lines) are preferred; a plain
  // tick is a fallback heartbeat with elapsed seconds. All pushes are
  // throttled to at most one per PROGRESS_INTERVAL so the bot does not spam;
  // the user can always pull an immediate update with a progress-query word.
  const onProgress = makeProgressSender(openid, msgId);

  const result = await execute(content, onProgress, { skipBusy: firstPartRuns, batchId: batchFirstId });
  try {
    await replyToUserBatched(openid, msgId, result);
  } catch (e) {
    log("REPLY ERROR " + e.message);
  }
}

function connect() {
  if (ws) { try { ws.close(); } catch (_) {} }
  log("CONNECTING " + GATEWAY);
  ws = new WebSocket(GATEWAY);
  ws.binaryType = "arraybuffer"; // ensure binary frames arrive as ArrayBuffer

  ws.addEventListener("open", () => log("WS OPEN"));

  ws.addEventListener("message", async (ev) => {
    let msg;
    try { msg = JSON.parse(await decodeData(ev.data)); } catch (_) { return; }
    const op = msg.op, t = msg.t;
    if (typeof msg.s === "number") lastSeq = msg.s;

    if (op === 10) {
      const hb = msg.d && msg.d.heartbeat_interval;
      log("WS HELLO hb=" + hb);
      let tok;
      try { tok = await ensureToken(); } catch (e) { log("IDENTIFY no token, retry in 5s"); setTimeout(connect, 5000); return; }
      ws.send(JSON.stringify({
        op: 2,
        d: { token: "QQBot " + tok, intents: INTENTS, shard: [0, 1], properties: { $os: "windows", $browser: "dsh-remote", $device: "dsh-remote" } }
      }));
      log("WS identify sent intents=" + INTENTS);
      startHeartbeat(hb || 45000);
    } else if (op === 0) {
      if (t === "READY") {
        sessionId = (msg.d && msg.d.session_id) || null;
        log("WS READY session=" + sessionId + " user=" + JSON.stringify(msg.d && msg.d.user));
        sendStartupGreeting();
      } else {
        await handleEvent(msg.d, t);
      }
    } else if (op === 11) {
      // heartbeat ack
    } else if (op === 7) {
      log("WS RECONNECT requested; reconnecting");
      ws.close();
    } else if (op === 9) {
      log("WS INVALID_SESSION; re-identify after close");
      ws.close();
    }
  });

  ws.addEventListener("error", e => log("WS ERROR " + (e && e.message ? e.message : e)));

  ws.addEventListener("close", ev => {
    log("WS CLOSE code=" + ev.code + " reason=" + ev.reason);
    stopHeartbeat();
    ws = null;
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(() => { reconnecting = false; connect(); }, 3000);
    }
  });
}

// ---- crash reporting -----------------------------------------------------
process.on("uncaughtException", e => {
  log("UNCAUGHT_EXCEPTION " + (e && e.stack ? e.stack : e));
});
process.on("unhandledRejection", (reason, p) => {
  log("UNHANDLED_REJECTION " + (reason && reason.stack ? reason.stack : reason));
});
process.on("exit", code => {
  try { fs.appendFileSync(LOG_PATH, new Date().toISOString() + " EXIT code=" + code + "\n"); } catch (_) {}
});

(async function main() {
  // Singleton guard: if another bridge daemon is already running (e.g. the
  // watchdog and a manual start raced), exit instead of double-connecting to
  // the QQ gateway.
  try {
    const oldRaw = fs.readFileSync(path.join(__dirname, "qq_remote_bridge.pid"), "utf8").trim();
    const oldPid = Number(oldRaw);
    if (oldPid && oldPid !== process.pid) {
      let alive = false;
      try { process.kill(oldPid, 0); alive = true; } catch (_) {}
      if (alive) {
        console.log("another qq_remote_bridge daemon running pid=" + oldPid + ", exiting");
        process.exit(0);
      }
    }
  } catch (_) {}
  try { fs.writeFileSync(path.join(__dirname, "qq_remote_bridge.pid"), String(process.pid)); } catch (_) {}
  log("=== qq_remote_bridge starting, pid=" + process.pid + " ===");
  log("authorized openids: " + Array.from(AUTHPASS).join(","));
  // Clear any stale scheduled shutdown left over from a previous daemon run,
  // so a 30s power-off cannot silently fire after a daemon restart.
  cancelShutdown().then(r => { if (r.ok) log("cleared stale pending shutdown"); });
  connect();
})();

// keep alive
setInterval(() => {}, 1 << 30);
