# QQ 开放平台机器人 API 速查（实战验证）

> 本文件基于 qq-remote-bridge 实际接入过程中验证过的接口与协议整理。
> 一手文档：https://bot.qq.com/wiki/develop/api-v2/

## 0. 从零接入（获取 appId / clientSecret / user_openid）

**Step 1 — 创建机器人，拿 appId 与 clientSecret**
1. 登录 [QQ 开放平台管理端](https://q.qq.com/) → 「机器人」→「创建机器人」（或进入已有机器人）
2. 在「开发设置」页面找到 **AppID**（数字）与 **AppSecret**（保密字符串）
3. 记下这两个值，即 `appId` / `clientSecret`。AppSecret 请妥善保管，勿写入公开文档。

**Step 2 — 获取你的 user_openid**
1. 把机器人添加到你的 QQ（单聊私聊；若是群机器人则拉进群）
2. 用你的 QQ 给机器人**私聊任意一条消息**（如「1」）
3. 此时机器人会通过 WebSocket 收到一条 `C2C_MESSAGE_CREATE` 事件，事件里 `d.author.user_openid` **就是你的 `user_openid`**（一个 32 位十六进制字符串）
4. 把该 openid 填入配置的 `authorizedOpenids`（只有这个 openid 的指令才会被执行）

> 提示：也可用本 skill 的 daemon 以 `intents=33554432` 订阅该事件，或临时用任意 WebSocket 客户端连接网关并打印收到的事件来读取 `user_openid`。

**Step 3 — 可选：配置 IP 白名单**
- `getAppAccessToken` 无 IP 限制；但**数据接口**（`/users/@me`、发消息等）默认要求来源 IP 在白名单。若不配置，会报 `11298 接口访问源IP不在白名单`
- 处理方式二选一：到后台「开发设置 → IP 白名单」添加你的出口公网 IP；或直接移除白名单设置（默认空即不限制，实测可用）

## 1. 获取访问令牌

```
POST https://bots.qq.com/app/getAppAccessToken
Content-Type: application/json

{"appId":"<APPID>","clientSecret":"<SECRET>"}
```

响应（HTTP 200）：
```json
{"access_token":"...","expires_in":"7200"}
```

要点：
- token 生命周期 7200s；到期前 60s 内重新请求会拿到新 token，旧 token 60s 内仍有效
- **令牌接口无 IP 白名单限制**（实测可从任意出口调用）
- 注意：官方 API 调用指南页的 URL 写 `https://api.bot.qq.com/app/getAppAccessToken`，但实测 `bots.qq.com` 亦可（本 skill 用 `bots.qq.com`）

## 2. 数据接口鉴权

统一基础域名：`https://api.bot.qq.com`（旧文档也出现过 `api.sgroup.qq.com`，二者都通）

**请求头**：`Authorization: QQBot <access_token>`（不是 `Bot appid.token`！）

验证接口：`GET /users/@me` → 200 返回机器人 id/username/bot 标识。

## 3. WebSocket 事件接入

- 网关地址：`GET /gateway` → `{"url":"wss://api.sgroup.qq.com/websocket"}`
- 建连后首帧：`op:10 Hello {"d":{"heartbeat_interval":41250}}`
- 发 `op:2 Identify`：
```json
{"op":2,"d":{"token":"QQBot <access_token>","intents":33554432,"shard":[0,1],"properties":{"$os":"windows","$browser":"x","$device":"x"}}}
```
- 成功后收到 `op:0 t:"READY"`（含 session_id、user.id、user.username、shard）
- 心跳：按 heartbeat_interval 周期发 `{"op":1,"d":<最新s>}`，服务端回 `op:11`

### intents 位（按需订阅）
| 位 | 值 | 事件 |
|----|-----|------|
| GUILDS | 1 | 频道基础事件 |
| GUILD_MEMBERS | 2 | 频道成员 |
| GUILD_MESSAGES | 512 (1<<9) | 私域频道消息 |
| GUILD_MESSAGE_REACTIONS | 1024 (1<<10) | 频道消息表情 |
| DIRECT_MESSAGE | 4096 (1<<12) | 频道私信 |
| **GROUP_AND_C2C_EVENT** | **33554432 (1<<25)** | `C2C_MESSAGE_CREATE`（单聊）、`GROUP_AT_MESSAGE_CREATE`（群@）、`GROUP_MSG_RECEIVE` |
| INTERACTION | 67108864 (1<<26) | 互动事件 |
| MESSAGE_AUDIT | 134217728 (1<<27) | 消息审核 |
| FORUMS_EVENT | 268435456 (1<<28) | 论坛事件（私域） |
| AUDIO_ACTION | 536870912 (1<<29) | 音频 |
| PUBLIC_GUILD_MESSAGES | 1073741824 (1<<30) | 公域频道消息 |

### C2C_MESSAGE_CREATE 事件结构（单聊消息）
```json
{"op":0,"s":2,"t":"C2C_MESSAGE_CREATE","d":{
  "author":{"bot":false,"id":"<USER_OPENID>","union_openid":"","user_openid":"<USER_OPENID>","username":""},
  "content":"1",
  "id":"ROBOT1.0_xxxxxxxx...!",
  "message_scene":{"ext":["msg_idx=REFIDX_..."],"source":"default"},
  "message_type":0,
  "timestamp":"2026-08-31T17:56:05+08:00"
}}
```
关键字段：`d.author.user_openid`（回复目标）、`d.id`（被动回复 msg_id）、`d.content`（指令内容）。

## 4. 发送消息

### 单聊消息（C2C / 私聊）
```
POST /v2/users/{user_openid}/messages
Authorization: QQBot <token>

{"msg_type":0,"content":"你好，世界","msg_id":"ROBOT1.0_...","msg_seq":1}
```
- `msg_type`：0=文本(content)、2=Markdown(markdown)、6=输入中(input_notify)、7=富媒体(media)
- 被动回复必须携带事件里的 `msg_id`（单聊有效期 60 分钟，每消息最多回 4 次；群聊 5 分钟 5 次）
- `msg_seq` 递增可避免相同 msg_id 重复回复被去重
- 主动消息不带 msg_id（但受频控与用户「允许主动发送」开关约束）
- 成功响应：`{"id":"ROBOT1.0_...","timestamp":"...","ext_info":{"ref_idx":"REFIDX_..."}}`

### 群聊消息
```
POST /v2/groups/{group_openid}/messages
```
参数同单聊；群被动有效期 5 分钟、5 次。

### 撤回
- 单聊：`DELETE /v2/users/{user_openid}/messages/{message_id}`
- 群聊：`DELETE /v2/groups/{group_openid}/messages/{message_id}`
- 发送超 2 分钟不可撤回

## 5. 常见错误码

| 码 | 含义 | 处理 |
|----|------|------|
| 11243 | Token 错误 | 检查鉴权头格式是否为 `QQBot <token>` |
| 11298 | 接口访问源 IP 不在白名单 | 后台移除/加白该出口 IP（或改用已授权出口） |
| 11001 | 不支持的调用 | 该能力未开通（如群机器人调频道接口） |
| 40034101 / 40054003 | 机器人非群成员 | 先把机器人拉进群 |
| 40054004 | 无好友关系 | 单聊主动消息需先加好友 |
| 40054013 | 用户拒收主动消息 | 用户关闭了「允许主动发送」 |
| 40034006 | 消息内容违规 | 修改内容 |
| 40054005 | 消息被去重 | 递增 msg_seq |
| 40034100 | 主动消息超频控 | 降频等待配额 |
| 40054016 | 机器人已下线 | 检查机器人状态 |

## 6. 本机实测记录（2026-08-31）

- 取 token：`bots.qq.com` 200 OK
- `/users/@me`：`api.bot.qq.com` 200，`{"id":"1833684139695563459","username":"远程操控电脑","bot":true}`
- `/gateway`：`wss://api.sgroup.qq.com/websocket`
- WS 链路：OPEN → HELLO(41250) → Identify(intents=33554432) → READY
- 收 `C2C_MESSAGE_CREATE`（content="1"）→ 被动回复「你好，世界」HTTP 200
- 常驻 daemon 收到 `help` → 执行 powershell → 回复 HTTP 200
- 自然语言（如「帮我看看 D:\... 目录下有哪些文件」）→ headless 会话处理 → 结论回推 HTTP 200

## 7. 中文编码排障（重要）

**症状**：白名单命令（`ipconfig`、`systeminfo` 等原生 exe）的输出中文乱码（`��̫��`）。

**根因**：中文 Windows 上原生命令向 stdout 输出 **GBK(cp936) 字节**；`execFile(..., {encoding:"utf8"})` 按 UTF-8 解码导致乱码。PowerShell 的 `[Console]::OutputEncoding=UTF8` **不能转换原生程序直写管道的字节流**，无效。

**修复（daemon 已采用）**：`execFile` 用 `encoding:"buffer"` 收集原始字节 → `decodeAuto()`：先按 UTF-8 严格解码，若含 `\uFFFD` 替换符则用 `new TextDecoder("gbk")` 回退解码。已验证：
- GBK 字节 → 正确还原中文
- UTF-8 字节 → 原样通过
- Node 24 的 `TextDecoder("gbk")` 需 ICU 支持（本机 OK）

**教训**：daemon 内部日志写 UTF-8 文件，用 **Node 以 UTF-8 读取**才见真面目；pwsh 的 `Get-Content` 默认按 GBK 读 UTF-8 文件，会显示乱码造成误判（曾误以为是 WS 解码问题）。

## 8. headless 步骤补丁（真实执行步骤回推）

**背景**：DSH 的 `headless` 运行时默认只在结束输出最终文本，**运行中不暴露中间步骤**。为了让 QQ 桥在任务执行中回推「正在执行的步骤」，对 `dsh-headless` 插件打一个本地补丁，把 agent 的中间事件（推理 thinking、工具调用）以 `[STEP]` 前缀**实时打印到 stdout**，由 daemon 的 `spawn` 监听流式转发。

**补丁位置**：`%USERPROFILE%\.dsh\profiles\node_modules\@deepseek-ai\dsh-headless\lib\index.js`
（改前先 `Copy-Item index.js index.js.bak` 备份）

**改动点**：在 `run()` 中、`agent.followup(...)` 之前插入：

```js
const unsubSteps = ctx.on("session/event", (_session, event) => {
  try {
    const t = event?.type;
    if (t === "assistant/message") {
      const blocks = event?.data?.message?.content ?? [];
      const think = blocks.filter(b => b.type === "thinking" || b.type === "reasoning")
                          .map(b => b.text ?? b.thinking ?? "").join("");
      if (think.trim()) {
        // 必须折叠为单行：多行思考会让桥的行解析把续行当作"结论"混入最终回复
        const oneLine = think.trim().replace(/\s+/g, " ").slice(0, 150);
        process.stdout.write(`[STEP] 推理: ${oneLine}\n`);
      }
    } else if (String(t).startsWith("tool/")) {
      process.stdout.write(`[STEP] 工具: ${t}\n`);
    } else if (t === "turn/start") {
      process.stdout.write(`[STEP] 开始处理…\n`);
    }
  } catch (_) {}
});
agent.followup(...);
await agent.whenIdle();
unsubSteps?.();
```

**v2.2.0 追加——审批 answerer（权限请求流转）**：在同一补丁中再注册一个 `approval/request` answerer，把审批请求打印为 `[APPROVAL] <pid> <tool> <reason>` 单行，并从 stdin 读取 `approval:allow:<pid>` / `approval:reject:<pid>` 决定；同意时调用 `setSandboxMode(session, "danger-full-access")` 把会话转入全盘可写模式；120 秒未答复自动回落 `unavailable`（fail closed）。需在文件顶部加 `import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";`，并在 `agent.followup(...)` 前插入：

```js
const pendingApprovals = new Map();
if (process.stdin && typeof process.stdin.setEncoding === "function") {
  process.stdin.setEncoding("utf8");
  let stdinBuf = "";
  process.stdin.on("data", (chunk) => {
    stdinBuf += chunk;
    const lines = stdinBuf.split("\n");
    stdinBuf = lines.pop() || "";
    for (const line of lines) {
      const m = line.trim().match(/^approval:(allow|reject):([A-Za-z0-9]+)$/);
      if (!m) continue;
      const settle = pendingApprovals.get(m[2]);
      if (settle) { pendingApprovals.delete(m[2]); settle(m[1] === "allow" ? "allowed-once" : "rejected"); }
    }
  });
}
const unsubApproval = ctx.on("approval/request", (_req, _next) => new Promise((resolve) => {
  try {
    const pid = Math.random().toString(36).slice(2, 10);
    const reason = String(_req && _req.reason ? _req.reason : "").replace(/\s+/g, " ").slice(0, 300);
    const tool = String(_req && _req.toolName ? _req.toolName : "");
    process.stdout.write(`[APPROVAL] ${pid} ${tool} ${reason}\n`);
    const timer = setTimeout(() => {
      if (pendingApprovals.has(pid)) { pendingApprovals.delete(pid); resolve("unavailable"); }
    }, 120000);
    pendingApprovals.set(pid, (outcome) => {
      clearTimeout(timer);
      if (outcome === "allowed-once") {
        try { setSandboxMode(_req.agent.session, "danger-full-access"); } catch (_) {}
      }
      resolve(outcome);
    });
  } catch (_) { resolve("unavailable"); }
}), { global: true });
// ...agent.followup(...); await agent.whenIdle(); unsubSteps?.(); unsubApproval?.();
```

桥侧（daemon）配套：spawn 时 `stdio: ["pipe","pipe","pipe"]`；解析 `[APPROVAL]` 行 → 主动消息询问用户；用户回复「同意/拒绝」→ 向子进程 stdin 写入 `approval:allow/reject:<pid>`；任务结束清空挂起态。daemon 侧逻辑见 `qq_remote_bridge.js` 的「permission-request relay」段。

**验证**：跑任意 headless 任务，stdout 应出现单行 `[STEP] 推理: ...` / `[STEP] 工具: tool/call`，最终结论文本单独一行。

**注意事项**：
- 补丁在 `profiles/node_modules` 下，**DSH 升级 / pnpm 重装会被覆盖**，需重新打
- 该补丁会让**所有** headless 调用在 stdout 输出 `[STEP]` 行（不影响最终结论文本输出，最终文本在 `[STEP]` 之后单独一行）
- daemon 已实现**自动退化**：若 stdout 无 `[STEP]`（补丁缺失），进度回退为按 `progressIntervalMs`（默认 60s）的时间心跳，功能不受影响
- v2.1.2 起，daemon **不会**把 `[STEP] 推理` 内容推送给用户（进度只回推工具动作），且从最终回复中剥离所有 `[STEP]` 行——推理折叠单行是防止多行污染的关键

## 9. headless 沙箱配置（安全默认与浏览器等跨沙箱工具）

**安全默认（推荐）**：headless 会话默认 `workspace-write` 沙箱（工作区可写、工作区外受限）+ approval `ask`（带确认）。**无需任何配置**——这是出厂默认，也是远程常驻场景的安全基线：agent 只能读写会话工作区，不能越权。

**局限**：`workspace-write` 会拒绝启动工作区外的程序（如 web-access 的 `msedge.exe`），agent 请求升级 `danger-full-access` 时 headless 无交互审批者，审批结果 `unavailable`，浏览器路线会卡死（实测踩坑：热点查询任务因无法启动 Edge 停滞约 3 分钟；无浏览器的 web_search 路线不受影响）。

**可选提权（仅当你确实需要浏览器等跨沙箱工具时）**：把 headless profile 设为「全盘可写 + 带确认」（sandbox `danger-full-access` + approval `ask`）。编辑 `%USERPROFILE%\.dsh\profiles\headless\cordis.patch.yml`：

```yaml
- id: sandbox-policy
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.cwd()
- id: approval
  config:
    policy: ask
```

（可选）与 web profile 对齐的预设表（`full-access-ask` = 全盘可写带确认）：

```yaml
- id: permission
  config:
    presets:
      read-only:        { sandbox: read-only,         approval: ask }
      workspace-write:  { sandbox: workspace-write,   approval: ask }
      danger-full-access:{ sandbox: danger-full-access, approval: never }
      full-access-ask:  { sandbox: danger-full-access, approval: ask }
```

**注意**：
- 该策略是纯模式制（无路径放行表），`danger-full-access` 即等效放行一切程序与路径
- 全盘可写意味着 agent 可读写全盘，请仅在可信的常驻远程控制场景使用；普通操作不再触发审批，「带确认」仅作敏感操作的兜底
- 恢复安全默认：把 `cordis.patch.yml` 改回 `[]`（或删除提权条目）即可回到 `workspace-write`
- 修改对每个新 headless 任务即时生效（无需重启 daemon）

## 10. 实战排障手册（本机实测）

### 10.1 headless 子进程永不退出（结论发不出）
审批 answerer 给 `process.stdin` 加了 `data` 监听后，运行结束事件循环被**打开的 stdin 管道**挂住，`io.exit` 只设 exitCode、靠事件循环自然退出 → 进程挂死，daemon 等不到 close，结论永远不发。
**修复**：任务结束（`whenIdle` 后）必须 `process.stdin.removeAllListeners("data")` + `process.stdin.destroy()`，并清空挂起审批计时器。

### 10.2 daemon 卡死且日志静默（回复管线挂起）
`httpJson` 无超时：一次停滞的连接让 `await replyToUser` 永不返回 → 该任务管线永久挂起（daemon 事件循环空转，不再有日志）。
**修复**：所有 HTTPS 请求 `req.setTimeout(15000, ...)` 失败即 destroy；被拒后由上层 try/catch 继续。

### 10.3 并发双开 + activeHeadless 覆盖（审批串号）
多条消息的 handleEvent 异步并发：审批/通知的 `await` 间隙内，第二个消息可能通过忙碌检查并 spawn → `activeHeadless` 被后 spawn 覆盖 → 前任务的 `[APPROVAL]` 自动放行被写进**错误子进程** stdin → 审批失败闭合、任务失败。
**修复**：`taskSlotBusy` 在任务提交执行瞬间（先于任何 await）同步占位；handleEvent / execute / drainTaskQueue 统一检查；任务 finish 时释放。

### 10.4 会话文件是多帧 zstd（解压只得到 147 字节）
`~/.dsh/sessions/<ws>/<session>/session.jsonl.zstd` 每次追加写一**帧**（实测 129 帧），`zstdDecompressSync` 只解第一帧（仅 manifest）。
**修复**：按帧魔数 `28 b5 2f fd` 切分，逐帧 `zstdDecompressSync` 后拼接。

### 10.5 PowerShell 的 `curl` 是别名
`curl` = `Invoke-WebRequest`，`curl -s -X POST --data-raw` 会报"positional parameter"错。
**修复**：一律 `curl.exe`（agent 曾踩坑后自我纠正，站点经验中应注明）。

### 10.6 原生命令中文乱码（GBK）
`ipconfig`/`systeminfo` 等原生程序直写 GBK 字节流，`encoding:"utf8"` 解码乱码；PowerShell 的 `[Console]::OutputEncoding=UTF8` 无效。
**修复**：`execFile(..., {encoding:"buffer"})` 收集原始字节 → 先 UTF-8 严格解码，含 `\uFFFD` 则 `TextDecoder("gbk")` 回退。

### 10.7 PID 复用误判
Windows 短时间可复用 PID：`Get-Process -Id` 判活可能命中无关新进程。
**修复**：判活结合命令行特征（`CommandLine -match`）或 pid 文件内容比对。

### 10.8 长回复链接/emoji 跨段
硬切 1500 字符会切断 URL 与 emoji 代理对。
**修复**：`splitRespectingUrls`——边界命中 URL 时切到 URL 结束（或段首附近的长 URL 切到其开始）；`charCodeAt(end-1)` 为高代理位（0xD800-0xDBFF）则顺延 1。

### 10.9 `C:\` 根目录写入失败（非沙箱问题）
普通用户（IsAdmin=False）在系统盘根目录写入被 OS 拒绝（`Access denied`），即使已获 danger-full-access。
**修复**：agent 应诊断"管理员权限"而非反复重试；提示改用可写目录。

### 10.10 双 daemon（watchdog 与手动启动撞车）
重启 daemon 时 watchdog 30s 检查可能同时拉起一个 → 双进程双连 QQ 网关（表现为双份问候/双份处理）。
**修复**：daemon 启动时读 pid 文件，若旧实例存活则自动退出（单例守卫）。
