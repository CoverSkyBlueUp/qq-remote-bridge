# qq-remote-bridge

腾讯开放平台（QQ 机器人）**常驻远程控制桥**。一套可分享、可复现的部署方案，让任何 Windows 机器登录后自动接入 QQ 机器人，通过私聊实时远程访问 / 查询本机。

基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的 `headless` 会话驱动，全部脚本按**自身所在目录**推断路径，解压到任意目录即可运行，不依赖某台机器的固定路径。

## 功能

- **常驻守护**：WebSocket 连接 QQ 开放平台网关，自动获取 / 刷新 `access_token`（7200s，提前 60s 刷新），断线自动重连、心跳保活
- **仅响应授权 openid**：只有配置的 `authorizedOpenids` 里的单聊消息才会被处理
- **白名单只读命令**：`help` / `ls` / `dir` / `ps` / `tasklist` / `ipconfig` / `systeminfo` / `whoami` / `hostname` / `ver` / `date` / `time` / `echo` 等，直接执行并返回（`help` 显示分组菜单）
- **自然语言 → DSH agent 会话**：任何非白名单的明确文字，转交 DSH `headless` 新会话处理（标准模式 + 可配置沙箱 + 可配置工作区，默认 `%USERPROFILE%\dsh-qqbot-workspace`），先发送确认消息，**处理过程中按节流间隔回推真实执行步骤**（仅工具动作，推理内容不回推），结束回推结论（超长自动分批）
- **进度节流 + 按需查询**：进度推送至少间隔 `progressIntervalMs`（默认 60s）；任务进行中发 `进度` / `进展` / `进行到哪` / `还在吗` 等可**立即**收到当前进度，不会新建会话
- **中断当前任务**：处理中发 `中断` / `取消` / `stop` / `cancel` / `abort` 可**真正杀掉**正在运行的 agent 任务（而非再开一个）
- **崩溃自愈**：`watchdog` 每 30s 检查 daemon，异常自动重启
- **登录自启**：注册登录自启计划任务（Logon 触发 + 30s 延迟 + 失败重启，与 DSH 自身自启机制一致），Windows 登录后随 DSH 自动拉起
- **上线问候**：机器人上线（WS READY）时向授权用户主动发送问候——当前时间、星期、距下一个中国法定节假日天数（官方 2026 安排，每年需更新 `CN_HOLIDAYS` 表）、按时段问候（早上/中午/下午/晚上）；可用配置 `startupGreeting: false` 关闭
- **权限请求流转**：任务中 agent 需要更高权限（沙箱拒绝）时，主动推送请求到 QQ；回复「同意」= 该会话转入**全盘可写模式**继续，「拒绝」= 维持工作区模式（120 秒未回复自动拒绝）
- **无窗口运行**：通过 `wscript` 隐藏控制台窗口，不打扰用户

### 消息流（自然语言任务）

1. ✅ 已收到，正在新建会话处理你的请求，请稍候…（发「进度」可随时查询，「中断」可停止）
2. ⚙️ 工具: tool/call…（`[STEP]` 步骤，受 `progressIntervalMs` 节流，默认 ≥60s 一条；推理内容不回推）
3. （兜底：无新步骤时按 `progressIntervalMs` 发「⏳ 仍在处理中」心跳）
4. 处理中发 `进度` 等查询词 → 立即回推当前任务 / 已运行秒数 / 最近工具步骤（不新建会话）
5. （最终结论；超长结论按 `replyContentLimit` 分批发送，最多 6 批）

> 真实步骤依赖对 `dsh-headless` 插件的本地补丁（见 `references/qq-bot-api.md` 第 8 节）；DSH 升级会覆盖，需重打；补丁缺失时自动退化为按 `progressIntervalMs`（默认 60s）时间心跳。若任务需要浏览器等跨沙箱工具，headless profile 需配置「全盘可写 + 带确认」沙箱（见第 9 节）。

## 前置条件

| 项 | 要求 |
|----|------|
| 操作系统 | Windows 10/11（中文环境已验证） |
| Node.js | 22+（需内置 `node:zlib` 的 zstd 解压与全局 `WebSocket`） |
| QQ 开放平台机器人 | 已创建并拿到 appId / clientSecret |
| DeepSeek Harness | 已安装 `dsh` CLI，`headless` 配置可用 |
| 你的 user_openid | 私聊机器人一次后，从 `C2C_MESSAGE_CREATE` 事件读取 `d.author.user_openid` |

## 快速部署

### 方式 A：一键部署脚本（推荐）

把本仓库的 `scripts/` 复制到目标机器任意目录（如 `D:\qq-bridge`），然后：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy.ps1 `
  -AppId <APPID> -ClientSecret <SECRET> -OpenId <USER_OPENID>
```

若 `dsh` 装在非默认路径，可加 `-DshBin "C:\...\dsh\lib\bin.js"`；工作区可用 `-Workspace "D:\my-workspace"` 覆盖（默认 `%USERPROFILE%\dsh-qqbot-workspace`）。脚本会：
1. 生成 `qq_bridge_config.json`
2. 注册登录自启计划任务 `DSH_QQ_Remote_Bridge`（随登录启动，自动移除旧 Startup 条目防双开）
3. 启动 daemon + watchdog
4. 打印日志

### 方式 B：手动部署

复制 `scripts/` 到目标目录，编辑 `qq_bridge_config.json`（参考 `templates/qq_bridge_config.json.template`），填入 appId / clientSecret / authorizedOpenids，然后：
1. 运行 `qq_bridge_silent.vbs` 启动 daemon（无窗口）
2. 运行 `qq_bridge_watchdog.ps1` 启动看门狗
3. 注册登录自启计划任务（见 `SKILL.md` 方式 B，Logon 触发 + 30s 延迟，与 DSH 自身自启机制一致）

### 安装为 DSH skill（直接安装 / 询问 DSH 安装）

**直接安装**（仓库根目录）：
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1        # 安装到 ~/.dsh/skills/qq-remote-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Force # 覆盖重装
```

**询问 DSH 安装**：在任意 DSH 会话（web GUI / headless）里说：
> 把 qq-remote-bridge skill 安装到技能目录，并协助部署机器人。

DSH agent 会按 `SKILL.md` 执行安装与部署（复制目录 / 运行 `install.ps1` / 运行 `deploy.ps1`）。

## 从零接入（获取 appId / clientSecret / user_openid）

1. 登录 [QQ 开放平台管理端](https://q.qq.com/) → 「机器人」→ 创建机器人
2. 在「开发设置」获取 **AppID** 与 **AppSecret**
3. 用你的 QQ 私聊机器人一条消息，机器人通过 WebSocket 收到 `C2C_MESSAGE_CREATE` 事件，其中 `d.author.user_openid` 就是你的 `user_openid`，填入配置的 `authorizedOpenids`
4. 数据接口默认要求来源 IP 在白名单：到后台添加你的出口公网 IP，或移除白名单设置（默认空即不限制）

## 部署后验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File check-status.ps1
```

- 日志出现 `WS READY session=...` 即上线
- 私聊机器人发 `help` → 收到「可用只读命令…」
- 发一条自然语言（如「查一下当前时间」）→ 收到确认 + 进度心跳 + 结论

## 常用命令（用户侧）

| 指令 | 作用 |
|------|------|
| `help` | 列出全部可用命令 |
| `ls C:\`、`dir C:\` | 列目录 |
| `ps` / `tasklist` | 进程列表 |
| `ipconfig` / `systeminfo` / `whoami` / `ver` | 系统信息 |
| `echo <词>` | 回显 |
| 任意自然语言 | 转交 DSH agent 新会话处理（工作区见 `workspace` 配置） |
| `进度` / `进展` / `还在吗` | 任务进行中立即查询当前进度 |
| `中断` / `取消` / `stop` | 终止正在运行的 agent 任务；也可取消待执行的关机 |
| `shutdown` / `关机` | 调度 **60 秒后关机**（期间发 `中断`/`取消`/`stop` 可取消） |

## 日常运维

| 操作 | 命令 |
|------|------|
| 查状态 | `check-status.ps1` |
| 手动启动 | `qq_bridge_silent.vbs` + `qq_bridge_watchdog.ps1` |
| 停止 | `uninstall.ps1 -KeepConfig` |
| 完全卸载 | `uninstall.ps1` |
| 看日志 | 安装目录下 `qq_remote_bridge.log` / `qq_remote_bridge_watchdog.log` |
| 发主动消息 | `node send_active_msg.js "你好，世界"`（利用配置里的 openid） |

自定义命令：编辑 `qq_remote_bridge.js` 中的 `ALLOWED`（只读白名单）与 `DANGEROUS`（危险关键字正则）。

## 安全边界

- 仅响应 `authorizedOpenids` 中的 openid
- 白名单**只读命令**直接执行；危险 / 写入 / 删除关键字（`del` / `rm` / `format` / `shutdown` / `>` / `&&` / `|` / `;` 等）拒绝
- 自然语言转交 DSH headless 会话，受 DSH `workspace-write` 沙箱约束
- 回复截断至 `replyContentLimit`（默认 1500 字符）
- **请勿把真实 `clientSecret` 写入任何分享文档**；模板用 `<...>` 占位

## 排障

见 [references/qq-bot-api.md](references/qq-bot-api.md)。常见问题：
- `11298` 来源 IP 不在白名单 → 后台添加 / 移除白名单
- `11243` Token 错误 → 检查鉴权头为 `QQBot <access_token>`
- 白名单命令输出中文乱码 → daemon 已做 UTF-8 / GBK 自动解码
- 自然语言无进度心跳 → 确认任务非白名单且 headless 会话真实在跑

## License

MIT，见 [LICENSE](LICENSE)。
