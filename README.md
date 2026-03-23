# CLI WeChat Bridge

将微信接入本地 AI 编码工作流的桥接工具。

本项目用于桥接微信消息与本地运行的 `codex`、`claude` 或持久化 `powershell.exe` 会话，并将本地输出、审批请求与运行状态同步回微信。当前实现以 `codex` 工作流为中心展开，重点是保留本地原生终端体验，并在此基础上提供微信侧的远程输入、结果回流与状态同步能力。

> 当前支持状态说明  
> - `codex`：当前优先支持的适配器，功能链路最完整，完成度最高  
> - `claude code`：已接入基础桥接，但受当前 channels 链路与交互模型限制，尚未完善  
> - `shell`：可用，适合持久化 PowerShell 会话桥接

## 这个项目解决什么问题

本项目面向这样一类使用场景：

- 你的主工作流仍在本地终端中进行
- 你希望继续使用原生 `codex` 或其他 CLI 工具，而不是迁移到网页或托管机器人
- 你希望在离开电脑时，仍能通过微信向本地会话发送请求，并接收必要的输出、审批与状态同步

当前项目并不试图把微信变成新的主工作界面。相反，它的定位是：

- 本地 CLI 仍然是主工作界面
- 微信是远程入口
- 会话一致性、线程状态和审批流仍以本地会话为中心

## 快速开始

### 环境要求

- Windows 为当前主要验证环境
- Node.js `>= 24.0.0`
- Bun `>= 1.0.0`
- 已安装以下至少一种本地 CLI：
  - `codex`
  - `claude`
  - `powershell.exe`

### 1. 克隆仓库并安装依赖

```bash
git clone https://github.com/UNLINEARITY/CLI-WeChat-Bridge
cd claude-code-wechat-channel
bun install
```

### 2. 安装全局命令

如果你希望在任意目录直接使用本项目：

```bash
npm install -g .
```

开发阶段也可以使用：

```bash
npm link
```

说明：

- `npm link` 会让全局命令直接指向当前仓库源码
- `npm install -g .` 会安装一份当前仓库的复制版本；后续代码更新后需要重新执行一次

### 3. 完成微信登录

```bash
bun run setup
```

该流程会：

1. 获取微信登录二维码
2. 在终端打印二维码
3. 等待你在微信中扫码并确认
4. 将 bot 凭据写入本地数据目录

默认凭据文件路径：

```text
~/.claude/channels/wechat/account.json
```

当前授权模型如下：

- 不使用 `/pair`
- `account.json.userId` 对应的微信账号即为唯一授权 owner
- 只有该账号发送的消息会被 bridge 接受

### 4. 启动 `codex` 模式

假设你的项目目录是：

```bash
cd D:\work\my-project
```

终端 A：

```bash
wechat-bridge-codex
```

终端 B：

```bash
wechat-codex
```

然后即可：

- 在微信中发送普通文本
- 在本地 `wechat-codex` 中继续原生交互
- 在本地执行 `/resume` 切线程
- 让微信自动跟随当前本地线程

如果你第一次使用本项目，建议优先从 `codex` 模式开始。当前仓库中，`codex` 是实现最完整、会话一致性与本地/远程衔接能力最完善的适配器路径。

### 5. 启动其他模式

`claude`：

```bash
cd D:\work\my-project
wechat-bridge-claude
```

`shell`：

```bash
cd D:\work\my-project
wechat-bridge-shell
```

## 适配器支持情况

| 适配器 | 当前状态 | 说明 |
| --- | --- | --- |
| `codex` | 当前优先支持，完成度最高 | 双终端模式；本地 panel 为线程权威；微信跟随本地线程；本地与远程衔接能力最完整 |
| `claude` | 已接入，尚未完善 | 当前仍以持久 PTY 会话桥接为主；尚未达到与 `codex` 同等级的会话一致性 |
| `shell` | 可用 | 持久 `powershell.exe` 会话；高风险命令支持审批 |

### 关于 `codex`

`codex` 是当前仓库完成度最高的适配器路径，也是当前文档与功能定义的中心。当前实现已经完整覆盖以下关键链路：

- 保持本地可见 Codex 面板
- 保持本地原生会话习惯
- 让微信与本地活动线程持续同步
- 保留本地线程权威并让微信跟随本地线程
- 支持本地输入镜像、最终回复回传、审批转发与状态查询

如果你的目标是评估这个仓库当前最成熟、最稳定的使用方式，应以 `codex` 模式为准。

### 关于 `claude code`

`claude code` 当前已经接入基础桥接能力，包括：

- 微信到本地 `claude` 会话的输入转发
- 本地输出回传
- 基于文本模式的审批识别

但它目前仍未达到 `codex` 的完成度。主要原因不是简单的工程排期，而是当前 **channels 链路与交互模型限制** 会直接影响以下能力：

- 会话一致性
- 本地与远程的上下文连续性
- 本地交互与微信侧远程控制之间的衔接方式

因此，当前 README 的主体说明、使用建议与行为定义都以 `codex` 为中心。

## 命令说明

### 推荐全局命令

```bash
wechat-bridge-codex
wechat-codex
wechat-bridge-claude
wechat-bridge-shell
```

### 仓库内开发入口

```bash
bun run setup
bun run bridge:codex
bun run codex:panel
bun run bridge:claude
bun run bridge:shell
bun run bridge:bun -- --adapter codex
bun run test
```

### Bridge CLI 参数

适用于：

- `wechat-bridge-codex`
- `wechat-bridge-claude`
- `wechat-bridge-shell`

示例：

```bash
wechat-bridge-codex --cwd D:\work\my-project
wechat-bridge-claude --profile work
wechat-bridge-shell --cmd pwsh.exe
```

支持参数：

- `--cwd <path>`：指定工作目录
- `--cmd <executable>`：覆盖默认命令
- `--profile <name-or-path>`：向适配器传入 profile

### `wechat-codex` 参数

```bash
wechat-codex --cwd D:\work\my-project
```

支持参数：

- `--cwd <path>`：显式连接该目录对应的 bridge endpoint

## 微信侧支持的指令

| 指令 | 说明 |
| --- | --- |
| 普通文本 | 发送给当前活动会话 |
| `/status` | 查看 bridge 当前状态 |
| `/stop` | 中断当前任务 |
| `/reset` | 重建当前本地会话 |
| `/confirm <code>` | 通过审批 |
| `/deny` | 拒绝审批 |
| `/resume` | 在 `codex` 模式下禁用；请在本地 `wechat-codex` 中执行 |

## `codex` 模式说明

### 双终端结构

`codex` 模式采用双终端结构：

- `wechat-bridge-codex` 负责微信通信、状态同步、审批处理和输出批处理
- `wechat-codex` 负责本地可见 Codex 面板

这种结构的目的是将微信桥接与本地可见面板分离，从而尽可能保留本地终端的原生交互。

### 线程规则

当前 `codex` 模式的线程规则非常明确：

- 本地 `wechat-codex` 当前线程是唯一权威来源
- 微信跟随本地线程
- 微信不会主动切换 `codex` 线程
- 微信 `/resume` 在 `codex` 模式下被禁用
- 本地 `/resume` 后，微信自动跟随新的活动线程

### 微信会同步什么

微信侧会接收到：

- 普通输出文本
- 本地输入摘要 `Local Codex input`
- 最终回复
- 审批请求
- 线程切换提示
- 必要错误信息

微信侧不会接收到：

- 原始 TUI 控制字符
- Alt-screen 重绘内容
- 大量界面刷新噪声
- 冗余心跳信息

### Codex 原生历史

Codex 的正常会话历史仍由 Codex 自身维护，默认保存在：

```text
~/.codex/sessions
```

本项目不会替代 Codex 自己的历史机制，而是在当前工作区内跟随活动线程。

## 工作区模型

本项目采用“当前目录即当前工作区”的模型：

- 从哪个目录启动 `wechat-bridge-codex`，哪个目录就是当前工作区
- `wechat-codex` 必须连接同一工作区
- 不同工作区的状态文件相互隔离

当前不是“一个全局守护进程同时管理多个仓库”的架构，而是：

- 单 owner
- 单 bridge
- 单活动工作区

## 数据目录与状态文件

默认数据目录：

```text
~/.claude/channels/wechat
```

主要文件如下：

| 路径 | 作用 |
| --- | --- |
| `account.json` | 微信凭据 |
| `sync_buf.txt` | iLink 增量同步游标 |
| `context_tokens.json` | 微信上下文 token 缓存 |
| `bridge.log` | bridge 运行日志 |
| `bridge.lock.json` | bridge 运行锁 |
| `workspaces/<workspace-key>/bridge-state.json` | 当前工作区状态 |
| `workspaces/<workspace-key>/codex-panel-endpoint.json` | 当前工作区 panel endpoint |

### 环境变量

| 变量名 | 说明 |
| --- | --- |
| `WECHAT_ILINK_BASE_URL` | 覆盖默认 iLink API 地址 |
| `CLAUDE_WECHAT_CHANNEL_DATA_DIR` | 覆盖默认数据目录 |

## 安全与授权

### 单 owner 模型

- bridge 只接受 `account.json.userId` 对应微信账号的消息
- 其他账号会被明确拒绝

### 审批机制

审批主要出现在以下场景：

- CLI 需要 yes/no 或 confirm
- `shell` 模式中的高风险命令需要确认

微信审批方式：

```text
/confirm <code>
/deny
```

### 本地通信范围

Codex 的 app-server 与 panel 之间的通信只监听 `127.0.0.1`，不默认暴露到公网。

## 常见问题

### 1. `wechat-codex` 提示找不到 bridge

通常原因如下：

- 还没有先启动 `wechat-bridge-codex`
- bridge 与 panel 不在同一个目录
- 当前工作区 endpoint 文件不存在

建议：

1. 先在目标目录启动 `wechat-bridge-codex`
2. 再在同一目录启动 `wechat-codex`

### 2. 全局命令不存在

请确认已经执行以下之一：

```bash
npm install -g .
```

或：

```bash
npm link
```

如果命令仍不存在，请检查 npm 全局 bin 目录是否已加入 `PATH`。

### 3. Windows 下出现 `codex.ps1` 或 PowerShell profile 警告

项目已经尽量规避 `codex.ps1`：

- 优先查找 vendor `codex.exe`
- 必要时通过 `cmd.exe` 包装 `codex.cmd`

如果本机 PowerShell profile 本身受执行策略限制，终端仍可能打印相关警告。这通常不是 bridge 本身故障。

### 4. 微信上提示没有 context token

通常表示当前联系人还没有建立可用的 iLink 上下文。一般先由 owner 账号发送一条普通消息即可建立上下文。

### 5. `codex is still working...`

该提示只应在当前确实存在活动任务时出现。

如果已经升级到最新版本但仍偶发出现：

1. 先确认本地 `wechat-codex` 是否真的仍在执行任务
2. 必要时使用 `/stop`
3. 若状态仍不一致，可执行 `/reset`
4. 检查：

```text
~/.claude/channels/wechat/bridge.log
```

### 6. 本地 `/resume` 后微信不同步

请优先确认：

1. `wechat-bridge-codex` 与 `wechat-codex` 是否都已重启到同一版本
2. 如果使用的是：

```bash
npm install -g .
```

则代码更新后需要重新执行：

```bash
npm install -g .
```

## 已知限制

- 当前主要在 Windows 环境下验证
- `codex` 是当前优先支持的路径
- `claude code` 目前受 channels 链路与交互模型限制，尚未达到 `codex` 的完成度
- `codex` 模式下微信 `/resume` 被禁用
- 当前模型是单 owner、单 bridge、单活动工作区
- 当前仍依赖 iLink / ClawBot 这一链路

## 开发说明

### 主要入口

| 文件 | 作用 |
| --- | --- |
| `wechat-bridge.ts` | bridge 主事件循环 |
| `bridge-adapters.ts` | `codex` / `claude` / `shell` 适配器实现 |
| `codex-panel.ts` | `wechat-codex` 启动入口 |
| `codex-panel-link.ts` | bridge 与 Codex panel 的本地 IPC |
| `wechat-transport.ts` | iLink 消息收发 |
| `bridge-state.ts` | bridge 状态、锁与日志 |
| `setup.ts` | 登录与凭据初始化 |

### 测试

```bash
bun test
```

当前测试主要覆盖：

- Windows 启动解析
- Codex 线程跟随
- session log fallback
- panel / busy / completion recovery
- 工作区路径与状态隔离

## 运行时说明

在 Windows 上，交互式 `node-pty`、ConPTY 以及相关 CLI 进程管理在 Node.js 下比 Bun 更稳定，尤其体现在：

- `codex`
- `claude`
- 本地 PTY / ConPTY 管理

因此当前策略是：

- `setup` 与测试继续使用 Bun
- 正式 bridge 运行时默认使用 Node.js
- `bun run bridge:*` 仍然是仓库内开发入口

## License

MIT
