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

// ---- read-only command execution ----------------------------------------
// Whitelist of safe commands. Each entry: prefix -> validator/executor.
// We ONLY run commands that are clearly read-only. The 3-arg execFile avoids
// any shell injection; we pass the raw command string as the single argument
// after a fixed binary. No shell, no metacharacter expansion.
const ALLOWED = new Set([
  "help", "ls", "dir", "pwd", "cwd", "ps", "tasklist", "ipconfig", "systeminfo",
  "whoami", "hostname", "ver", "date", "time", "echo"
]);

const DANGEROUS = /\b(del|erase|rmdir|rm|rd|format|shutdown|restart|reboot|reg\s+delete|kill|taskkill|move|copy|xcopy|ren|rename|mkdir|md|takeown|icacls|cipher|cacls|attrib|certutil|wevtutil|bcdedit|diskpart|vssadmin|format|mklink|remove|remove-item|clear|stop-process|stop-service|disable|uninstall|drop|truncate|write|set-content|add-content|out-file|>|<|>>|&&|\||;)\b/i;

function stripDangerous(s) {
  return DANGEROUS.test(s);
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
      stdio: ["ignore", "pipe", "pipe"]
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
      resolve(out.trim() || "[agent 未返回结论]");
    };

    // Accumulate non-STEP stdout/stderr (the final conclusion). [STEP] lines
    // are real intermediate steps -> forward to onProgress as live updates
    // and strip them from the accumulated output so the final reply is the
    // agent's conclusion only.
    let stepAccum = "";
    const handleChunk = (c) => {
      const s = c.toString("utf8");
      stepAccum += s;
      const lines = stepAccum.split("\n");
      stepAccum = lines.pop(); // keep partial last line
      for (const ln of lines) {
        const m = ln.match(/^\[STEP\]\s*(.*)$/);
        if (m && onProgress) {
          if (activeTask) activeTask.lastStep = m[1].trim();
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

  // Interrupt command: kill the running headless task (if any), and do NOT
  // start a new one. Recognized words trigger an abort of the current turn.
  if (isInterrupt(trimmed)) {
    if (activeHeadless && !activeHeadless.killed) {
      try { activeHeadless.kill("SIGTERM"); } catch (_) {}
      // Give it a moment then force if needed
      setTimeout(() => {
        if (activeHeadless && !activeHeadless.killed) { try { activeHeadless.kill("SIGKILL"); } catch (_) {} }
      }, 1500);
      return "✅ 已中断当前正在运行的任务。";
    }
    return "当前没有正在运行的任务。";
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
      "  中断 / 取消 / stop / cancel / abort"
    ].join("\n");
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

function truncate(s) {
  if (s.length <= REPLY_LIMIT) return s;
  return s.slice(0, REPLY_LIMIT) + "\n...[输出已截断 " + (s.length - REPLY_LIMIT) + " 字符]";
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

  // Natural-language (non-whitelist, non-interrupt) tasks first send an
  // immediate acknowledgment so the user knows a new session is running.
  // Interrupt commands are NOT acknowledged as a new session and are handled
  // directly by execute().
  if (!isWhitelistCommand(content) && !isInterrupt(content)) {
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
      let note;
      if (p && p.kind === "step") {
        const text = String(p.text || "").slice(0, 120);
        note = "⚙️ " + (text || "正在执行…");
      } else {
        const secs = p && p.secs ? p.secs : Math.round((now - lastProgressAt) / 1000);
        note = "⏳ 仍在处理中…(已运行 " + secs + " 秒,发「进度」可查询详情)";
      }
      await replyToUser(openid, msgId, note, nextMsgSeq(msgId));
      lastProgressAt = now;
    } catch (e) {
      log("PROGRESS REPLY ERROR " + e.message);
    }
  };

  const result = await execute(content, onProgress);
  const reply = truncate(result);
  try {
    await replyToUser(openid, msgId, reply, nextMsgSeq(msgId));
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
  connect();
})();

// keep alive
setInterval(() => {}, 1 << 30);
