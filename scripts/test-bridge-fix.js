// Unit tests for the qq_remote_bridge fixes (slash normalization + interrupt
// menu answer consumption + bare control words). Extracted pure logic mirror.
const ALLOWED = new Set([
  "help", "ls", "dir", "pwd", "cwd", "ps", "tasklist", "ipconfig", "systeminfo",
  "whoami", "hostname", "ver", "date", "time", "echo", "shutdown", "关机"
]);
const INTERRUPT_WORDS = new Set(["中断", "取消", "停止", "stop", "cancel", "abort", "halt"]);
const PROGRESS_QUERY_WORDS = ["进度", "进展", "进行到哪", "还在吗", "查询进度", "进度查询", "status", "progress"];

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
function isWhitelistCommand(cmd) {
  const first = normalizeSlash(cmd).split(/\s+/)[0].toLowerCase();
  return first === "help" || ALLOWED.has(first);
}
function isProgressQuery(cmd) {
  const t = cmd.trim().toLowerCase();
  return PROGRESS_QUERY_WORDS.some(w => t.includes(w));
}
const BARE_CONTROL = /^(全部|所有|全|当前|现在|本次|确认|确定|all|current|confirm)$/i;

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = String(actual) === String(expected);
  if (ok) { pass++; } else { fail++; console.log(`FAIL ${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`); }
}

// --- slash normalization / whitelist ---
eq(isWhitelistCommand("/help"), true, "/help is whitelist");
eq(isWhitelistCommand("help"), true, "help is whitelist");
eq(isWhitelistCommand("/ls"), true, "/ls whitelist");
eq(isWhitelistCommand("/ls C:\\"), true, "/ls C:\\ whitelist (first token)");
eq(isWhitelistCommand("/shutdown"), true, "/shutdown whitelist");
eq(isWhitelistCommand("/关机"), true, "/关机 whitelist");
eq(isWhitelistCommand("//help"), true, "//help whitelist (strip all slashes)");
eq(isWhitelistCommand("帮我查天气"), false, "natural language not whitelist");
eq(isWhitelistCommand("/帮我查天气"), false, "/natural language not whitelist");
eq(isWhitelistCommand("ls"), true, "ls whitelist");
eq(isAllowed("/ipconfig"), true, "/ipconfig allowed");
eq(isAllowed("/date"), true, "/date allowed");

// --- interrupt words with slashes ---
eq(isInterrupt("/stop"), true, "/stop interrupt");
eq(isInterrupt("/中断"), true, "/中断 interrupt");
eq(isInterrupt("stop"), true, "stop interrupt");
eq(isInterrupt("全部"), false, "全部 NOT an interrupt word (handled by pending menu)");
eq(isInterrupt("当前"), false, "当前 NOT an interrupt word");

// --- bare control words ---
eq(BARE_CONTROL.test("全部"), true, "bare 全部 is control word");
eq(BARE_CONTROL.test("当前"), true, "bare 当前 is control word");
eq(BARE_CONTROL.test("确认"), true, "bare 确认 is control word");
eq(BARE_CONTROL.test("当前汇率"), false, "当前汇率 not bare control");
eq(BARE_CONTROL.test("全部完成了吗"), false, "phrase not bare control");
eq(BARE_CONTROL.test("2"), false, "queue number not bare control");

// --- interrupt menu answer matching (mirror of the moved block) ---
const menuAnswer = (t) => {
  const num = /^(\d+)$/.exec(t);
  const all = /^(全部|所有|全|all)$/i.test(t);
  const cur = /^(当前|现在|本次)$/i.test(t);
  const confirm = /^(确认|是|确定|yes|ok)$/i.test(t);
  const cancel = /^(取消|否|放弃|算了|no)$/i.test(t) || t.startsWith("取消");
  return { num: !!num, all, cur, confirm, cancel };
};
eq(menuAnswer("全部").all, true, "menu answer 全部 -> all");
eq(menuAnswer("当前").cur, true, "menu answer 当前 -> cur");
eq(menuAnswer("1").num, true, "menu answer 1 -> num");
eq(menuAnswer("确认").confirm, true, "menu answer 确认 -> confirm");
eq(menuAnswer("取消").cancel, true, "menu answer 取消 -> cancel");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
