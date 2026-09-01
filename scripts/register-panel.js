// Register the whitelist commands as a QQ bot command panel (指令面板).
// POST /v2/panels with scope=c2c, target_type=all. Re-run to update (or use
// the returned panel_id with PUT /v2/panels/{panel_id}).
// Usage: node register-panel.js
const fs = require("fs");
const https = require("https");
const path = require("path");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "qq_bridge_config.json"), "utf8"));

function httpJson(host, method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (data) { h["Content-Type"] = "application/json"; h["Content-Length"] = Buffer.byteLength(data); }
    const req = https.request({ host, path: pathname, method, headers: h }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.setTimeout(15000, () => req.destroy(new Error("timeout " + method + " " + pathname)));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const PANEL = {
  scope: "c2c",
  target_type: "all",
  panel: {
    remark: "QQ 远程控制桥 · 白名单指令面板",
    items: [
      { type: "command", name: "help", desc: "显示指令菜单" },
      { type: "command", name: "ls", desc: "列目录 例: ls D:\\QQbot" },
      { type: "command", name: "dir", desc: "列目录(同 ls)" },
      { type: "command", name: "pwd", desc: "当前工作目录" },
      { type: "command", name: "cwd", desc: "当前工作目录" },
      { type: "command", name: "ps", desc: "进程列表" },
      { type: "command", name: "tasklist", desc: "进程列表" },
      { type: "command", name: "ipconfig", desc: "网络配置" },
      { type: "command", name: "systeminfo", desc: "系统信息" },
      { type: "command", name: "whoami", desc: "当前用户" },
      { type: "command", name: "hostname", desc: "主机名" },
      { type: "command", name: "ver", desc: "系统版本" },
      { type: "command", name: "date", desc: "当前日期" },
      { type: "command", name: "time", desc: "当前时间" },
      { type: "command", name: "echo", desc: "回显文字" },
      { type: "command", name: "shutdown", desc: "60秒后关机(可取消)" },
      { type: "command", name: "关机", desc: "60秒后关机(可取消)" }
    ]
  }
};

(async () => {
  const tokRes = await httpJson(config.tokenHost, "POST", "/app/getAppAccessToken", {}, {
    appId: config.appId, clientSecret: config.clientSecret
  });
  if (tokRes.status !== 200) { console.log("token fail", tokRes.status, tokRes.body); process.exit(1); }
  const token = JSON.parse(tokRes.body).access_token;
  const r = await httpJson(config.apiHost, "POST", "/v2/panels", {
    Authorization: "QQBot " + token,
    Accept: "application/json"
  }, PANEL);
  console.log("status=" + r.status);
  console.log(r.body);
})().catch(e => { console.error(e); process.exit(1); });
