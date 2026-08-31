// One-shot helper: send an active (proactive) C2C message to an authorized
// openid using the bridge config. Usage: node send_active_msg.js "<content>"
const fs = require("fs");
const https = require("https");
const path = require("path");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "qq_bridge_config.json"), "utf8"));
const content = process.argv[2] || "你好，世界";

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
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const tokRes = await httpJson(config.tokenHost, "POST", "/app/getAppAccessToken", {}, {
    appId: config.appId, clientSecret: config.clientSecret
  });
  if (tokRes.status !== 200) { console.log("token fail", tokRes.status, tokRes.body); process.exit(1); }
  const token = JSON.parse(tokRes.body).access_token;
  const body = { msg_type: 0, content, msg_seq: 1 };
  const r = await httpJson(config.apiHost, "POST", "/v2/users/" + config.authorizedOpenids[0] + "/messages", {
    Authorization: "QQBot " + token
  }, body);
  console.log("status=" + r.status);
  console.log(r.body);
})().catch(e => { console.error(e); process.exit(1); });
