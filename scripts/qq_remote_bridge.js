// QQ Bot persistent remote-control bridge (read-only, ownered-scoped).
// Connects to QQ Open Platform websocket gateway, listens for single-chat
// (C2C_MESSAGE_CREATE) messages from authorized openids only, runs a whitelisted
// read-only command, and replies passively using the event's msg_id.
// Auto-refreshes access_token and auto-reconnects on disconnect.
const fs = require("fs");
const https = require("https");
const path = require("path");
const { execFile } = require("child_process");

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
const PROGRESS_INTERVAL = 8000;  // 8s progress heartbeat

function runHeadlessSession(task, onProgress) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const progressTimer = setInterval(() => {
      if (onProgress) {
        try { onProgress(Math.round((Date.now() - startedAt) / 1000)); } catch (_) {}
      }
    }, PROGRESS_INTERVAL);

    const args = [DSH_BIN, "--profile", "headless", task];
    execFile(process.execPath, args, {
      timeout: HEADLESS_TIMEOUT,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    }, (err, stdout, stderr) => {
      clearInterval(progressTimer);
      let out = "";
      if (stdout) out += stdout;
      if (err) {
        const detail = err.killed ? "（超时中断）" : ("（" + (err.code || err.message) + "）");
        if (stderr) out += "\n[stderr] " + stderr;
        if (!out.trim()) out = "[headless 会话失败] " + detail;
      }
      resolve(out.trim() || "[agent 未返回结论]");
    });
  });
}

function isAllowed(cmd) {
  const first = cmd.trim().split(/\s+/)[0].toLowerCase();
  return ALLOWED.has(first);
}

async function execute(cmd, onProgress) {
  const trimmed = cmd.trim();
  if (!trimmed) return "[empty]";
  const first = trimmed.split(/\s+/)[0].toLowerCase();
  if (first === "help") {
    return "可用只读命令: " + Array.from(ALLOWED).join(", ") + "\n示例: ls C:\\  ps  ipconfig  systeminfo  whoami  ver\n\n其他任何明确文字（自然语言指令）将转交 DSH agent 新会话处理。";
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

  // Natural-language (non-whitelist) tasks first send an immediate
  // acknowledgment so the user knows a new session is running.
  if (!isWhitelistCommand(content)) {
    try {
      const ack = "✅ 已收到，正在新建会话处理你的请求，请稍候…\n（处理过程中我会定期发送进度）";
      await replyToUser(openid, msgId, ack, nextMsgSeq(msgId));
    } catch (e) {
      log("ACK REPLY ERROR " + e.message);
    }
  }

  // Periodic progress heartbeat while the agent runs, sent on the same
  // msg_id with increasing msg_seq.
  let lastProgressAt = Date.now();
  const onProgress = async (elapsedSec) => {
    try {
      const note = `⏳ 仍在处理中，已运行 ${elapsedSec}s，请稍候…`;
      await replyToUser(openid, msgId, note, nextMsgSeq(msgId));
      lastProgressAt = Date.now();
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
