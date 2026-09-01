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
  log("GREETING status=" + r.status + " openid=" + userOpenid.slice(0, 8) + "… " + r.body.slice(0, 200));
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

function handleApprovalLine(detail) {
  const sp = detail.indexOf(" ");
  const pid = sp < 0 ? detail : detail.slice(0, sp);
  const info = sp < 0 ? "" : detail.slice(sp + 1);
  if (!pid) return;
  pendingApprovalPid = pid;
  log("APPROVAL requested pid=" + pid + " " + info.slice(0, 150));
  const msg = "⚠️ Agent 请求更高权限：\n" + (info || "(未提供原因)") +
    "\n\n回复「同意」= 本次任务转入全盘可写模式；「拒绝」= 维持工作区模式。";
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

function progressStatus() {
  if (!activeTask) return "当前没有正在运行的任务。";
  const secs = Math.round((Date.now() - activeTask.startedAt) / 1000);
  const last = activeTask.lastStep ? "\n最近步骤: " + activeTask.lastStep.slice(0, 100) : "";
  return "⏳ 正在处理「" + activeTask.text.slice(0, 40) + "」,已运行 " + secs + " 秒。" + last + "\n(发「中断」可停止当前任务)";
}

function runHeadlessSession(task, onProgress) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    // Track task state for on-demand progress queries while it runs.
    activeTask = { text: task, startedAt, lastStep: "" };
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
      if (activeTask && activeTask.startedAt === startedAt) activeTask = null;
      if (pendingApprovalPid) pendingApprovalPid = null; // task gone, nothing to answer
      resolve(out.trim() || "[agent 未返回结论]");
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
function isInterrupt(cmd) {
  const t = cmd.trim().toLowerCase();
  return INTERRUPT_WORDS.has(t) || INTERRUPT_WORDS.has(t.replace(/[。.!！]/g, ""));
}

function isAllowed(cmd) {
  const first = cmd.trim().split(/\s+/)[0].toLowerCase();
  return ALLOWED.has(first);
}

async function execute(cmd, onProgress) {
  const trimmed = cmd.trim();
  if (!trimmed) return "[empty]";

  // Interrupt command: cancel a pending shutdown AND/OR kill the running
  // headless task. Never starts a new session.
  if (isInterrupt(trimmed)) {
    const msgs = [];
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

  // While a task is running, a new message must NOT spawn a second concurrent
  // headless session: progress-query words get an immediate on-demand push,
  // other natural language gets a busy notice with the current progress.
  if (activeHeadless && !activeHeadless.killed) {
    if (isProgressQuery(trimmed)) return progressStatus();
    if (!isWhitelistCommand(trimmed)) {
      return "⚠️ 上一任务仍在处理中,暂不新建会话。\n" + progressStatus();
    }
  }

  const first = trimmed.split(/\s+/)[0].toLowerCase();
  if (first === "help") {
    return [
      "🤖 QQ 远程控制 · 指令菜单",
      "━━━━━━━━━━━━━━━━━━",
      "📂 目录 / 信息",
      "  ls / dir  列目录  例: ls C:\\",
      "  pwd / cwd 当前目录",
      "  ps / tasklist  进程列表",
      "  ipconfig  网络配置",
      "  systeminfo  系统信息",
      "  whoami  当前用户",
      "  hostname / ver / date / time",
      "  echo  <词>  回显",
      "━━━━━━━━━━━━━━━━━━",
      "💬 其它明确文字 = 转交 AI agent 处理",
      "  先确认 → 定期进度(约60秒) → 回结论",
      "  处理中发「进度」可立即查询当前进展",
      "━━━━━━━━━━━━━━━━━━",
      "🛑 中断当前任务",
      "  中断 / 取消 / stop / cancel / abort",
      "💻 关机",
      "  shutdown / 关机  60 秒后关机",
      "  期间发「中断 / 取消」可取消"
    ].join("\n");
  }
  if (first === "shutdown" || trimmed === "关机") {
    if (trimmed !== "shutdown" && trimmed !== "关机") {
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
  if (isAllowed(trimmed)) {
    if (stripDangerous(trimmed)) {
      return "[拒绝] 检测到危险关键字，已阻止执行。";
    }
    const out = await runCmd(trimmed);
    return out;
  }
  // Non-whitelist explicit text -> delegate to a fresh DSH headless session
  // (standard preset, workspace-write, default workspace). The daemon runs
  // outside the DSH sandbox (started by Startup), so spawning dsh works here.
  return runHeadlessSession(trimmed, onProgress);
}

// Batch a long reply into multiple passive messages on the same msg_id
// (increasing msg_seq), instead of truncating it to one message. At most
// BATCH_MAX_CHUNKS chunks of REPLY_LIMIT chars each; anything beyond is
// summarized with an omission note.
const BATCH_MAX_CHUNKS = 6;
async function replyToUserBatched(openid, msgId, content) {
  if (!content) return;
  const chunks = [];
  let remaining = content;
  while (remaining.length > 0 && chunks.length < BATCH_MAX_CHUNKS) {
    chunks.push(remaining.slice(0, REPLY_LIMIT));
    remaining = remaining.slice(REPLY_LIMIT);
  }
  if (remaining.length > 0) {
    chunks[chunks.length - 1] += "\n...[其余 " + remaining.length + " 字符已省略]";
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
  const first = cmd.trim().split(/\s+/)[0].toLowerCase();
  return first === "help" || ALLOWED.has(first);
}

async function handleEvent(d, t) {
  const author = d && d.author ? d.author : {};
  const openid = author.user_openid || author.id;
  if (!openid || !AUTHPASS.has(openid)) {
    log("IGNORED from non-authorized openid=" + openid + " event=" + t);
    return;
  }
  const content = (d && d.content) || "";
  const msgId = parseMsgId(d);
  if (!msgId) {
    log("IGNORED no msg_id, openid=" + openid);
    return;
  }
  log(`CMD openid=${openid} content=` + JSON.stringify(content));

  // While an approval request is pending, the next user message answers it
  // (before anything else: no ack, no new session, no interrupt handling).
  if (pendingApprovalPid && activeHeadless && !activeHeadless.killed) {
    const t = content.trim().toLowerCase();
    const allow = /^(同意|允许|可以|批准|确认|ok|yes|是|好)$/i.test(t) || /^(同意|允许|可以|批准|确认)/.test(t);
    const reject = /^(拒绝|不同意|不行|取消|中断|stop|cancel|abort|no|否|否决|不要)$/i.test(t) || /^(拒绝|不同意|否决)/.test(t);
    let reply;
    if (allow || reject) {
      const pid = pendingApprovalPid;
      pendingApprovalPid = null;
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

  // Only acknowledge when a new headless session will actually be started:
  // progress queries and busy-notice messages (a task is already running and
  // this message won't spawn a session) must NOT get the "starting a new
  // session" ack — they get their direct reply from execute() instead.
  const startsNewSession = !isWhitelistCommand(content) && !isInterrupt(content) &&
    !isProgressQuery(content) && !(activeHeadless && !activeHeadless.killed);
  if (startsNewSession) {
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
  const onProgress = async (p) => {
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

  const result = await execute(content, onProgress);
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
