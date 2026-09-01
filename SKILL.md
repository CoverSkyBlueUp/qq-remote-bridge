---
name: qq-remote-bridge
license: MIT
github: https://github.com/CoverSkyBlueUp/qq-remote-bridge
description:
  腾讯开放平台（QQ 机器人）常驻远程控制桥：一套可分享、可复现的部署方案，让任何 Windows 机器登录后自动接入 QQ 机器人，通过私聊实时远程访问/查询本机。
  触发场景：用户要求部署/接入腾讯或 QQ 机器人、重装系统后重新部署、通过 QQ 发指令查询本机、排查机器人收不到/回不了消息、启动/停止/卸载 QQ 桥。
metadata:
  author: CoverSkyBlueUp
  version: "2.2.2"
---

# qq-remote-bridge Skill（可分享部署版）

本 skill 是一套**可由任何人从零部署**的 QQ 机器人远程控制桥。所有脚本路径都基于**自身所在目录**（`__dirname` / `~dp0` / 脚本目录）推断，因此解压到任意目录都能运行，不依赖某台机器的固定路径。

> **关于本 skill 内的脚本**：`scripts/` 是**原模板**（路径全部可移植）。实际部署时把整个 `scripts/` 解压到目标机器的任意目录（如 `D:\qq-bridge`），然后运行其中 `deploy.ps1` 即可。它们也提供了 `check-status.ps1` / `uninstall.ps1` 供日常使用。

---

## 一、功能概述

一个常驻 Node.js 守护进程（`qq_remote_bridge.js`）：

- WebSocket 连 QQ 开放平台网关（`wss://api.sgroup.qq.com/websocket`），订阅 `intents=33554432`（单聊 `C2C_MESSAGE_CREATE` + 群 @ `GROUP_AT_MESSAGE_CREATE`）
- 自动获取/刷新 `access_token`（7200s，提前 60s 刷新）
- **仅响应授权 openid** 的单聊消息
- **白名单只读命令**直接执行（`help`/`ls`/`ps`/`ipconfig`/`systeminfo` 等）
- **中断指令**（`中断`/`取消`/`停止`/`stop`/`cancel`/`abort`/`halt`）→ 真正地**杀掉正在运行的 headless 任务**，并**取消待执行的关机**，而非新开一个
- **关机指令**：`shutdown`/`关机` → 调度 **60 秒后关机**；期间发中断指令可取消；daemon 启动时自动清理残留关机计时器（防 daemon 重启后误关机）
- **非白名单自然语言** → 转交 DSH headless 新会话处理（标准模式 + 可配置沙箱 + 可配置工作区），先发确认消息，**过程中按节流间隔回推真实执行步骤**（仅工具调用等可执行动作，来自 headless 插件补丁的 `[STEP]` 事件；推理/思考内容不回推），结束发结论（超长自动分批）
- **进度节流 + 按需查询**：进度推送至少间隔 `progressIntervalMs`（默认 60s，配置可调）；任务进行中发 `进度`/`进展`/`进行到哪`/`还在吗` 等可**立即**收到当前进度回推，不会新建会话
- 断线自动重连、心跳保活；由 `watchdog` 保证 daemon 崩溃自愈；由**登录自启计划任务**（Logon 触发，与 DSH 自身自启机制一致）随登录自动拉起
- **全程无窗口**：daemon 与 watchdog 均经 **wscript + VBS** 静默启动（`qq_bridge_silent.vbs` / `qq_bridge_watchdog_silent.vbs`），开机不出现任何 PowerShell 弹窗
- **上线问候**：机器人上线（WS READY）时向授权用户主动发送问候——当前时间、星期、距下一个中国法定节假日天数（`CN_HOLIDAYS` 表，官方 2026 安排，每年需更新）、按时段问候（早上/中午/下午/晚上）；配置 `startupGreeting: false` 可关闭
- `showWindow`/wscript 无窗口运行，不弹控制台

### 消息流（自然语言任务）
1. ✅ 已收到，正在新建会话处理你的请求，请稍候…（发「进度」可随时查询，「中断」可停止）
2. ⚙️ 工具: tool/call…（`[STEP]` 步骤，受 `progressIntervalMs` 节流，默认 ≥60s 一条；**推理内容不回推**）
3. （兜底：无新步骤时按 `progressIntervalMs` 发「⏳ 仍在处理中」心跳）
4. 处理中发 `进度` 等查询词 → 立即回推当前任务/已运行秒数/最近工具步骤（不新建会话）
5. （最终结论；超长结论按 `replyContentLimit` 分批发送，最多 6 批）

> **真实步骤依赖 headless 补丁**：`[STEP]` 由对 `dsh-headless` 插件的本地补丁产生（`run()` 中 `ctx.on("session/event")` 监听，将推理/工具事件打印到 stdout，见 `references/qq-bot-api.md` 的「headless 步骤补丁」）。补丁内**推理内容已折叠为单行**（避免多行换行破坏桥的行解析）。DSH 升级会覆盖此补丁，需重新打。若补丁缺失，daemon 自动退化为按 `progressIntervalMs` 的时间心跳。

> **安全默认（workspace-write）**：headless 会话默认运行在 `workspace-write` 沙箱（工作区可写、工作区外受限）+ approval `ask`，这是远程常驻场景的安全基线，**无需配置**。局限：浏览器等跨沙箱工具（如 web-access 的 Edge 调试模式）会被沙箱拒绝启动；此时 agent 应回退到无浏览器的 web_search 路线，或触发下面的**权限请求流转**。

### 权限请求流转（按需全盘模式）
任务执行中若 agent 发现需要更高权限（沙箱拒绝工作区外写入/启动程序），会发出权限请求，桥会**主动推送**到你的 QQ：
> ⚠️ Agent 请求更高权限：… 回复「同意」= 本次任务转入全盘可写模式；「拒绝」= 维持工作区模式。

- 回复 `同意`/`允许`/`可以` → 该会话**转入 danger-full-access 全盘可写模式**继续（经 `setSandboxMode` 切换）
- 回复 `拒绝`/`取消`/`中断` → 保持 workspace-write，agent 按受限方式继续（升级请求失败闭合）
- **15 秒内未回复 → 自动按「拒绝」处理**（fail closed，不转移到 full-access，并告知用户）
- 机制：headless 补丁注册 `approval/request` answerer（stdout `[APPROVAL]` 上报 + stdin 决定回流），详见 `references/qq-bot-api.md`「headless 步骤补丁」；需要打该补丁才能使用本功能

### 中断（确认式选择）
发 `中断` / `取消` / `stop` / `cancel` / `abort` 不再立即执行，而是**先弹出确认/选择**：
- **队列非空**：列出队列任务，回复**序号**=中断该队列任务；**「全部」**=终止全部(含当前)；**「当前」**=仅中断当前任务；**「取消」**=放弃
- **仅当前任务**：回复「确认/是」=中断；「取消」=继续
- **15 秒内未回复 → 默认不操作**（当前任务继续、队列保留），并告知用户
- 中断同时会**取消待执行的关机**（立即执行，不等待确认）；无任务/队列时回复"当前没有正在运行的任务"

### 按需进度与任务队列
- 处理中发 `进度` / `进展` / `进行到哪` / `还在吗` / `status` / `progress` → 立即回推**当前任务进度 + 队列内待执行任务列表**
- 任务进行中再发**自然语言** → 不会并行开第二个会话,而是**加入任务队列**:
  > 📥 已加入任务队列(第 N 位):「…」当前任务完成后将自动执行。
- **单条消息多指令自动拆分**：一条消息含多个指令（以 `然后`/`接着`/`接下来`/`随后`/`之后`/`并且`/`还有` 等连接词分隔）会自动拆分为多个任务并入队，并告知用户拆分结果：
  > 📚 检测到 N 个指令，已自动拆分：1. … 2. … 现在开始执行第 1 个，其余已加入队列。
- **联网一次授权（15 秒确认）**：检测到可能联网的任务（含 搜索/新闻/天气/热点/资讯/网站/下载 等关键词）时，**先询问用户**再执行，提示采用统一权限格式且**只列出需要联网的指令**：
  > 🔐 权限请求 · 联网
  > 📋 需要联网的指令：1. … 2. …
  > 👉 回复「允许」= 联网执行；「拒绝」= 不执行
  > ⏱ 15 秒内未回复默认拒绝，任务不执行。
  授权仅限本次任务；**15 秒未回复 → 不授权、任务不执行也不入队**，并告知用户；配置 `netTaskAsk: false` 可关闭询问
- **权限提示统一格式**：联网/全盘可写/审批三类请求共用 `🔐 权限请求 · <类型>` 格式，且**只列出需求对应权限的指令**（混合批次中 web 与 full 指令分别归属各自请求）
- **官方指令面板**：`scripts/register-panel.js` 把白名单指令注册为 QQ 官方指令面板（`POST /v2/panels`，scope=c2c），用户点击面板即填入指令文本；运行 `node register-panel.js` 创建/更新，返回的 `panel_id` 可用于查改
- **批次统一授权**：单条消息拆分出的多个指令，按权限类型**批量授权**：
  - **全部只需要 web-access** → 一次 🔐 授权覆盖整批
  - **全部只需要 full-access**（含 `C:\`/`D:\`/工作区外/安装/注册表 等关键词）→ 一次 🔐 授权覆盖整批，运行中自动放行（不再逐任务询问）
  - **混合**（有的需 web、有的需 full）→ **分别授权**（先 web 后 full）
  - 批内任一权限 15 秒未回复 → 默认拒绝，本批不执行、不入队
- 当前任务执行完毕后，**队列中的任务按序自动执行**（每条会先发「✅ 开始执行队列任务…」，再走 ack/进度/结论流程，回复使用提交时那条消息的 msg_id）
- 配置 `autoSplitTasks: false` 可关闭自动拆分

---

## 二、前置条件

| 项 | 要求 |
|----|------|
| 操作系统 | Windows 10/11（中文环境已验证） |
| Node.js | 22+（需内置 `node:zlib` 的 zstd 解压与全局 `WebSocket`） |
| QQ 开放平台机器 | 一个已创建并拿到 appId/clientSecret 的机器人 |
| DSH | 目标机器已安装 DeepSeek Harness（`dsh` CLI 可用），headless 配置文件默认存在 |
| 你的 user_openid | 用你的 QQ 私聊机器人一次后，从 `C2C_MESSAGE_CREATE` 事件读取 `d.author.user_openid` |

## 三、部署（三选一）

### 方式 A：一键部署脚本（推荐）
把本 skill 的 `scripts/` 整目录复制到目标机器任意目录（如 `D:\qq-bridge`），然后：

```powershell
# 已拿到全部参数：
cd D:\qq-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 -AppId <APPID> -ClientSecret <SECRET> -OpenId <USER_OPENID>
```

若你的 `dsh` 装在非默认路径，可加 `-DshBin "C:\...\dsh\lib\bin.js"`。脚本会：
1. 生成 `qq_bridge_config.json`
2. 注册**登录自启计划任务** `DSH_QQ_Remote_Bridge`（Logon 触发 + 30s 延迟，经 wscript 静默运行 watchdog，与 DSH 自身登录自启机制一致，随登录自动拉起且无弹窗；自动移除旧 Startup 文件夹条目防双开）
3. 启动 daemon + watchdog
4. 打印日志

### 方式 B：手动部署
复制 `scripts/` 到目标目录，编辑 `qq_bridge_config.json`（参考 `templates/qq_bridge_config.json.template`），填入 appId/clientSecret/authorizedOpenids，然后：
1. 运行 `qq_bridge_silent.vbs` 启动 daemon（无窗口）
2. 运行 `qq_bridge_watchdog.ps1` 启动看门狗
3. 注册登录自启计划任务（推荐，与 DSH 一致）：
   ```powershell
   $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PWD\qq_bridge_watchdog.ps1`""
   $trigger = New-ScheduledTaskTrigger -AtLogOn; $trigger.Delay = "PT30S"
   $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
   Register-ScheduledTask -TaskName "DSH_QQ_Remote_Bridge" -Action $action -Trigger $trigger -Settings $settings -Force
   ```

### 方式 C：作为 DSH skill 安装到本机（直接安装）

**一键安装脚本**（仓库根目录）：
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1        # 首次安装
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Force # 覆盖重装
```
等价于手动把整个 `qq-remote-bridge/` 复制到 `%USERPROFILE%\.dsh\skills\qq-remote-bridge\`，之后任意 DSH 会话可加载该 skill、调用其脚本与文档。

### 方式 D：询问 DSH 安装

在**任意 DSH 会话**（web GUI 或 headless）里直接说：

> 把 qq-remote-bridge skill 安装到技能目录（~/.dsh/skills/qq-remote-bridge），并告诉我如何部署机器人。

DSH agent 会按本 SKILL.md 执行（复制目录或运行 `install.ps1`），然后你就可以继续让它协助部署 `deploy.ps1`。本仓库自包含，不依赖包管理器；「询问 dsh 安装」本质是把本文件交给 agent 执行。

## 四、部署后验证

```powershell
# 状态检查：进程 / 配置 / 日志 / 自启
powershell -NoProfile -ExecutionPolicy Bypass -File check-status.ps1
```
- 日志出现 `WS READY session=...` 即上线
- 用你的 QQ 私聊机器人发 `help` → 应收到「可用只读命令…」
- 发一条自然语言（如「查一下当前时间」）→ 应收到 ack + 进度心跳 + 结论

## 五、日常运维

| 操作 | 命令 |
|------|------|
| 查状态 | `check-status.ps1` |
| 手动启动 | 运行 `qq_bridge_silent.vbs` + `qq_bridge_watchdog.ps1` |
| 停止 | `uninstall.ps1 -KeepConfig`（或 `${pid}` 停止） |
| 完全卸载 | `uninstall.ps1`（停进程、移除自启、删配置；不删脚本） |
| 看日志 | 安装目录下 `qq_remote_bridge.log` / `qq_remote_bridge_watchdog.log` |

自定义命令：编辑 `qq_remote_bridge.js` 中的 `ALLOWED`（只读白名单）与 `DANGEROUS`（危险关键字正则）即可。

## 六、排障速查

见 `references/qq-bot-api.md`。常见问题：

- **`11298` 来源IP不在白名单** → 到 QQ 开放平台后台移除/添加出口 IP 白名单
- **`11243` Token错误** → 检查鉴权头为 `QQBot <access_token>`（非 `Bot appid.token`）
- **白名单命令输出中文乱码** → daemon 已做 UTF-8/GBK 自动解码（`decodeAuto`），若仍乱码检查 Node 的 ICU 支持
- **收不到消息** → 确认机器人已上线（`READY`）、daemon 进程存活、watdchog 在跑
- **自然语言无进度心跳** → 确认任务非白名单（白名单命令不回心跳），且 headless 会话真实在跑（观察日志 `PROGRESS`）
- **headless 未建会话** → 确认 `dsh --profile headless` 能跑（首次会创建 `.dsh\profiles\headless`）

## 七、安全边界

- 仅响应 `authorizedOpenids` 中的 openid
- 白名单**只读命令**直接执行；危险/写入/删除关键字（`del`/`rm`/`format`/`shutdown`/`>`/`&&`/`|`/`;` 等）拒绝
- 自然语言转交 headless 会话，受 DSH 沙箱约束（默认 `workspace-write`；若需浏览器等跨沙箱工具，配置「全盘可写 + 带确认」见 `references/qq-bot-api.md`，注意权衡全盘权限）
- 回复超长时按 `replyContentLimit`（默认 1500 字符）**分批发送**，最多 6 批，超出部分省略标注
- **不要把真实 `clientSecret` 写入任何会分享的文档**；模板用 `<...>` 占位
- 会话内沙箱操作被拒时，用 `sandbox_permissions: danger-full-access` 单次重试（登录常驻场景用户已授权），勿另寻绕过

## 八、版本记录

- v2.2.2：**快捷指令与中断交互修复**——QQ 快捷面板斜杠指令（`/help`、`/ls`…）与无斜杠形式等价匹配白名单；中断确认菜单答案（序号/`全部`/`当前`/`取消`）**提前消费**，不再被误当成新任务入队导致超时无操作；裸控制词（无待确认弹窗时发 `全部`/`当前`/`确认` 等）不再开新会话；批次授权弹窗的 `取消`/`拒绝` 正确应答；**可选 DSH 会话清理集成**（`qqbot-session-cleanup.ps1` + 静默 VBS：持续归档隐藏未分组 qqbot 会话 + bot 启动时删除闲置会话，watchdog 自动联动，全部经 wscript 无窗口运行）
- v2.2.1：**体验与经验沉淀**——help 面板分组统一；开机**全程无 PowerShell 弹窗**（watchdog 改经 wscript + VBS 静默启动）；权限提示统一 `🔐` 格式且**只列需求对应权限的指令**；白名单指令接入 **QQ 官方指令面板**（`register-panel.js`，`POST /v2/panels`）；并发加固（taskSlotBusy 原子占位防双开）与批次授权自动放行实测修复；实战排障经验沉淀见「九、实战经验沉淀」
- v2.2.0：**权限请求流转**（agent 需更高权限时经 QQ 询问用户，同意则会话转入全盘可写模式，headless 补丁注册 approval answerer + stdin 决定回流）；**上线问候**（时间/星期/距下个法定节假日/时段问候，`startupGreeting` 可关）；**关机指令**（`shutdown`/`关机`，60 秒延时、可取消）；**安装方式**（`install.ps1` 直接安装 + 询问 DSH 安装两种途径）；安全默认文档化（workspace-write + 按需提权）
- v2.1.2：推送与回复质量修复——进度推送**不再回推推理/思考内容**（仅工具动作；`[STEP]` 推理折叠单行防污染最终回复）；进度查询只显示工具步骤；修复 60s 节流竞态（曾导致进度连发爆发）；修复进度/忙碌消息**误发 ack**；**长结论分批发送**（默认 1500 字符/批，最多 6 批）
- v2.1.1：登录自启改为**计划任务**（Logon 触发 + 30s 延迟 + 失败重启，与 DSH 自身自启机制一致，随登录自动拉起）；deploy/uninstall/check-status 同步，移除旧 Startup 条目防双开
- v2.1.0：进度推送节流（`progressIntervalMs`，默认 60s，原 8s）；新增按需进度查询（`进度`/`进展` 等，处理中立即回推）；任务进行中再发自然语言不再并行开会话，改为忙碌提示 + 当前进度
- v2.0.0：可移植部署版——所有脚本改为按自身目录推断路径；新增 `deploy.ps1`/`uninstall.ps1`；自然语言任务带确认 + 8s 进度心跳；SKILL.md 改为从零部署手册
- v1.0.0：初版——http://常驻桥、只读命令、watchdog 自愈、登录自启

## 九、实战经验沉淀（本机实测踩坑）

> 详细排障手册见 `references/qq-bot-api.md` 第 10 节。此处为速查。

### 架构与运维
- **开机零弹窗**：所有自启一律走 `wscript + VBS`（`qq_bridge_silent.vbs` / `qq_bridge_watchdog_silent.vbs`）；`powershell -WindowStyle Hidden` 仍可能闪窗，wscript 永不产生控制台
- **防双 daemon**：watchdog 与手动启动可能撞车，daemon 启动时校验 pid 文件单例，重复实例自动退出
- **登录自启**用计划任务（Logon 触发 + 30s 延迟 + 失败重启），比 Startup 文件夹可靠

### 并发与任务
- **并发双开必须防**：多条消息的 handleEvent 是异步并发，审批/通知的 await 间隙可让第二个消息绕过忙碌检查 → 用 `taskSlotBusy` 在提交执行瞬间原子占位（先于任何 await）
- **activeHeadless 被覆盖会串号**：两个任务并发时后 spawn 的覆盖句柄，导致前一个任务的审批写进错误子进程 stdin → 审批失败闭合
- 任务队列用「提交消息的 msg_id」回 ack/进度/结论；短任务(<60s)无节流进度属正常

### 权限体系
- 三类权限请求（联网/全盘可写/运行时审批）统一 `🔐 权限请求 · <类型>` 格式，且**只列需求对应权限的指令**
- 批次统一授权：同权限整批一次授权；混合分别授权；批内任一 15s 未回复默认拒绝、整批不入队
- headless 无交互审批者 → 需打 `approval/request` answerer 补丁（stdout `[APPROVAL]` + stdin 回流），同意时 `setSandboxMode(session, danger-full-access)` 切换会话

### 排障速记
- **headless 子进程不退出**：审批 answerer 加了 stdin 数据监听后，事件循环被打开的 stdin 挂住 → 任务结束必须 `process.stdin.destroy()`（否则进程永不退出，结论发不出）
- **daemon 卡死无日志**：`httpJson` 无超时 → 停滞连接让回复管线永久挂起 → 所有 HTTP 请求加 15s 超时
- **会话文件是 zstd 多帧**：`session.jsonl.zstd` 每次追加写一帧（129 帧常见），`zstdDecompressSync` 只解第一帧 → 按帧魔数 `28b52ffd` 切分逐帧解压
- **PowerShell 的 curl 是别名**：`curl` = `Invoke-WebRequest`，必用 `curl.exe`（agent 曾踩坑后自我纠正）
- **中文乱码**：原生命令输出 GBK，用 `encoding:"buffer"` + UTF-8 严格解码失败后回退 GBK
- **PID 复用**：短时间内进程可能复用 PID，`Get-Process -Id` 判活可能误判 → 用命令行特征匹配兜底
- **链接跨段**：长回复分批时 URL 不能切断（`splitRespectingUrls`），emoji 代理对也不能切（按 charCodeAt 检查高代理位）
- **`C:\` 根目录写入失败**：非管理员用户被 OS 拒绝（`Access denied`），与沙箱无关——agent 应如实诊断而非反复重试
