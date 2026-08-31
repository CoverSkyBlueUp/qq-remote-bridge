---
name: qq-remote-bridge
license: MIT
github: https://github.com/CoverSkyBlueUp/qq-remote-bridge
description:
  腾讯开放平台（QQ 机器人）常驻远程控制桥：一套可分享、可复现的部署方案，让任何 Windows 机器登录后自动接入 QQ 机器人，通过私聊实时远程访问/查询本机。
  触发场景：用户要求部署/接入腾讯或 QQ 机器人、重装系统后重新部署、通过 QQ 发指令查询本机、排查机器人收不到/回不了消息、启动/停止/卸载 QQ 桥。
metadata:
  author: CoverSkyBlueUp
  version: "2.0.0"
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
- **中断指令**（`中断`/`取消`/`停止`/`stop`/`cancel`/`abort`/`halt`）→ 真正地**杀掉正在运行的 headless 任务**，而非新开一个
- **非白名单自然语言** → 转交 DSH headless 新会话处理（标准模式 + workspace-write + 默认工作区），先发确认消息，**过程中流式回推真实执行步骤**（推理/工具调用，来自 headless 插件补丁的 `[STEP]` 事件），结束发结论
- 断线自动重连、心跳保活；由 `watchdog` 保证 daemon 崩溃自愈；由登录启动项自动拉起
- `showWindow`/wscript 无窗口运行，不弹控制台

### 消息流（自然语言任务）
1. ✅ 已收到，正在新建会话处理你的请求，请稍候…
2. ⚙️ 推理: <agent 的真实思考> / ⚙️ 工具: tool/call…（`[STEP]` 流式实时回推）
3. （兜底：长时间无新步骤时发「⏳ 仍在处理中」心跳）
4. （最终结论）

> **真实步骤依赖 headless 补丁**：`[STEP]` 由对 `dsh-headless` 插件的本地补丁产生（`run()` 中 `ctx.on("session/event")` 监听，将推理/工具事件打印到 stdout，见 `references/qq-bot-api.md` 的「headless 步骤补丁」）。DSH 升级会覆盖此补丁，需重新打。若补丁缺失，daemon 自动退化为每 8 秒时间心跳。

### 中断
处理中发 `中断` / `取消` / `stop` / `cancel` / `abort` 可立即杀掉正在运行的 agent 任务并收到「✅ 已中断」。中断指令不会新建会话、不先发 ack。无运行任务时回「当前没有正在运行的任务」。

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
2. 把 `qq_remote_bridge_launch.cmd` 注册进用户 Startup 目录（登录自启）
3. 启动 daemon + watchdog
4. 打印日志

### 方式 B：手动部署
复制 `scripts/` 到目标目录，编辑 `qq_bridge_config.json`（参考 `templates/qq_bridge_config.json.template`），填入 appId/clientSecret/authorizedOpenids，然后：
1. 运行 `qq_bridge_silent.vbs` 启动 daemon（无窗口）
2. 运行 `qq_bridge_watchdog.ps1` 启动看门狗
3. 把 `qq_remote_bridge_launch.cmd` 的快捷方式放入 `shell:startup` 实现登录自启

### 方式 C：作为 DSH skill 安装到本机
复制整个 `qq-remote-bridge/` 到 `%USERPROFILE%\.dsh\skills\qq-remote-bridge\` 即可被 DSH 加载为 skill，之后任何会话可调用其脚本与文档。

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
- 自然语言转交 headless 会话，受 DSH **workspace-write 沙箱**约束（不会越权）
- 回复截断至 `replyContentLimit`（默认 1500 字符）
- **不要把真实 `clientSecret` 写入任何会分享的文档**；模板用 `<...>` 占位
- 会话内沙箱操作被拒时，用 `sandbox_permissions: danger-full-access` 单次重试（登录常驻场景用户已授权），勿另寻绕过

## 八、版本记录

- v2.0.0：可移植部署版——所有脚本改为按自身目录推断路径；新增 `deploy.ps1`/`uninstall.ps1`；自然语言任务带确认 + 8s 进度心跳；SKILL.md 改为从零部署手册
- v1.0.0：初版——http://常驻桥、只读命令、watchdog 自愈、登录自启
