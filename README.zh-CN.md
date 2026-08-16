<h1 align="center">DSH Coding Agent Preset（DSH 编码模式预设）</h1>

<p align="center">
  <a href="./README.md">English</a>
  &nbsp;·&nbsp;
  <strong>简体中文</strong>
</p>

**DSH Coding Agent Preset** 是为 DeepSeek Harness（DSH）打造的 Windows 适配版**“编码模式”Agent 预设**——官方**极简模式（minimal）**的 Windows 移植。它保留官方 minimal 的组成（固定 persona、无上下文压缩、仅 `pwsh` + `str_replace_editor` 两个工具），但把官方持久 bash 替换为**持久 PowerShell 7（pwsh）**。

- PTY 后端（`packages/dsh-terminal-pwsh/`）：基于 node-pty/ConPTY 的持久 pwsh 后端，仿照 `@deepseek-ai/dsh-terminal-bash`。
- 模型侧工具（`packages/dsh-tool-pwsh-persistent/`）：持久 pwsh 工具，仿照 `@deepseek-ai/dsh-tool-bash-persistent`。
- 预设文件（`agent.cordis.yml` / `preset.yml`）：把两个本地包挂载到 DSH 的 `coding` Agent 预设中。

---

## 安装

本项目以单个 npm 包（`@gamegeek-saikel/dsh-coding-agent-preset`）发布。安装到 DSH web profile 后，包的 `postinstall` 脚本会自动部署预设文件与两个内部包。

> **前置要求：** 本预设需要 **PowerShell 7（`pwsh`）**，不是 Windows 自带的 Windows PowerShell 5.1（`powershell.exe`）。请手动安装 PowerShell 7，例如从 <https://github.com/PowerShell/PowerShell/releases> 下载，或运行 `winget install Microsoft.PowerShell`。

安装到 web profile：

```bash
npx @deepseek-ai/dsh plugin --profile web add @gamegeek-saikel/dsh-coding-agent-preset
```

启动 DSH：

```bash
npx @deepseek-ai/dsh web
```

如果已全局安装 DSH CLI，也可以用 `dsh` 代替 `npx @deepseek-ai/dsh`：

```bash
dsh plugin --profile web add @gamegeek-saikel/dsh-coding-agent-preset
dsh web
```

本包也保留手动安装方式：将 `agent.cordis.yml` / `preset.yml` 复制到 `~/.dsh/.agent-presets/coding/`，然后运行 `install.ps1` 把两个内部包复制到 `~/.dsh/profiles/node_modules` 与 harness `node_modules`。

## Demo / 评测数据

使用 DeepSeek V4 Pro（`reasoningEffort=max`）在两条“一句话网页应用生成”任务上验证。两次会话都只使用 `pwsh` + `str_replace_editor`，并生成了完整的单文件 HTML Demo。

| 产物 | 推理模块 | we | let's | let me | 可见回复 | 工具调用 | 耗时 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `blackhole.html` | 98 | 411 | 383 | 6 | 1 | 102 | ~29 分钟 |
| `mc.html` | 162 | 525 | 539 | 4 | 1 | 167 | ~54 分钟 |

Demo 文件与 Session 日志：[`demo/`](demo/)  
完整分析：[`docs/pro-test-evaluation.md`](docs/pro-test-evaluation.md)

## 概述

官方持久 bash 后端无法在 Windows 上运行（其 subprocess 终端检查仅支持 Linux/macOS），而官方 `dsh-tool-pwsh` 又不是持久的（每次命令都新起一个 `pwsh -Command`）。因此本项目提供了一套 Windows 原生的持久 pwsh 栈，与官方持久 bash 保持相同的三层架构：

1. **PTY 注册表**——复用官方 `@deepseek-ai/dsh-terminal` 服务，并放在 agent 私有的 `terminals` realm 中。
2. **后端**——`dsh-terminal-pwsh` 通过 node-pty/ConPTY 直接启动 pwsh，用受控提示符检测就绪，并用 `taskkill` 清理进程树。
3. **工具**——`dsh-tool-pwsh-persistent` 实现相同的 start/end marker 协议与 PowerShell 命令包装，使 cwd、变量、函数、别名、激活的环境在多次调用间保持。

## 关键性质

| 性质 | 值 |
|---|---|
| 范围 | 官方 `minimal` 编码预设的 Windows 适配 |
| Shell | 持久 PowerShell 7（`pwsh`），基于 node-pty/ConPTY |
| 工具 | 仅 `pwsh` + `str_replace_editor` |
| Persona | 与官方 minimal 逐字一致：`You are a helpful software engineer assistant.` |
| 命令包装 | `Invoke-Expression` + 反引号转义双引号字符串；`$ErrorActionPreference = 'Stop'` |
| 就绪检测 | 受控提示符 `__DSH_PERSISTENT_PWSH_PROMPT__ ` + 静默/超时兜底 |
| 沙箱模式 | `danger-full-access` → 持久 PTY shell；受限模式 → 一次性 pwsh 执行 |
| 提权 | 单次 `sandbox_permissions` + `justification`，经 `ctx.approval` 审批；fail-closed |
| 模式切换 | 任何有效沙箱模式变化都会关闭持久终端；下一次调用按新模式重建 |
| 安装 | `dsh plugin --profile web add @gamegeek-saikel/dsh-coding-agent-preset` |
| 测试 | 提示面一致性、沙箱提权、沙箱模式切换 |
| 本地化 | 简体中文 + English（预设展示随 DSH Web 界面语言切换） |
| 许可证 | MIT |

## 用法

安装并重启后，“编码模式”会话内只会看到两个工具：`pwsh` 和 `str_replace_editor`。

- **持久路径**（`danger-full-access`）：命令运行在共享的持久 pwsh PTY 中。变量、函数、别名与当前目录在多次调用间保持。
- **受限路径**（`read-only` / `workspace-write`）：命令以一次性 `pwsh -Command` 方式执行，与官方非持久 `dsh-tool-pwsh` 行为一致，状态不保持。
- **沙箱提权**：受限命令被拒绝时，输出会包含 `[sandbox: file access denied ...]` 与 `escalation available — retry this exact command once with sandbox_permissions`。重试时带上 `sandbox_permissions` 和 `justification` 可申请单次审批；获批权限只作用于该次调用，不改变会话模式。

快速验证：

```powershell
Write-Output "hello"
```

然后在 `danger-full-access` 会话中再运行一条读取变量的命令，即可看到持久性。

## 架构

| 层 | 官方（bash，Linux/macOS） | 本项目（pwsh，Windows） |
|---|---|---|
| PTY 注册表 | `@deepseek-ai/dsh-terminal`（`terminals` 服务） | 复用官方同一服务，`isolate: terminals` 私有 realm |
| 后端 | `dsh-terminal-bash`（subprocess + Linux 进程检查器） | `dsh-terminal-pwsh`：node-pty/ConPTY、受控提示符就绪、`taskkill` 树清理 |
| 工具 | `dsh-tool-bash-persistent`（start/end marker 协议） | `dsh-tool-pwsh-persistent`：同一协议 + PowerShell 方言包装 |

关键实现点：

- **命令包装**——`Invoke-Expression` + 反引号转义双引号字符串；多行命令、`$` 插值与引号都能安全存活。
- **退出码语义**——`$ErrorActionPreference = 'Stop'` 使失败 cmdlet 对齐 bash 的非零退出语义；`try/catch` 与显式 `-ErrorAction` 不受影响。
- **就绪检测**——PowerShell/PSReadLine 会剥离 OSC 133 提示符标记，因此用受控提示符文本尾部匹配 + 静默/超时兜底。
- **生命周期**——超时关闭并重置 shell；`exit` 检测并重置；owner 级缓存与串行队列与官方设计一致。
- **双路径执行**——`danger-full-access` 使用持久 PTY shell；受限模式使用一次性执行。
- **单次提权**——`sandbox_permissions` + `justification` 经 `ctx.approval` 审批；拒绝、非加宽请求、缺 justification、无审批服务均 fail-closed。
- **沙箱模式切换**——任何有效模式变化都会在后台关闭持久终端；下一次调用透明地按新模式重建。
- **提示面一致性**——persona 与工具描述保持与官方 minimal 对齐；运行时不再拼接提权段落。

## 项目结构

```
dsh-coding-agent-preset/
├── agent.cordis.yml              # 根预设组合（手动安装用）
├── preset.yml                    # 根预设元数据（手动安装用）
├── cordis.patch.yml              # Web profile bundle 补丁（默认使用 coding 预设；替换 agent-preset UI）
├── presets/coding/               # npm 包内随附、可自动安装的预设目录
│   ├── agent.cordis.yml
│   └── preset.yml
├── dsh-coding-agent-client/      # dsh-client-ui-agent-preset 的 fork，加入 coding-mode 本地化支持
│   ├── package.json
│   └── lib/
│       ├── client.js             # 浏览器半区：把 coding 加入内置预设本地化表
│       └── index.js              # 宿主插件桩
├── install.ps1                   # 一键部署到当前 DSH
├── package.json                  # 用于 npm 发布的单包元数据
├── pnpm-lock.yaml                # 锁文件（npm/GitHub Actions 使用）
├── LICENSE                       # MIT 许可证
├── README.md                     # English documentation
├── README.zh-CN.md               # 简体中文文档
├── docs/
│   ├── pro-test-evaluation.md    # Pro 模式黑洞 / MC 评测数据
│   └── pro-test-data.json        # 机器可读的评测数据
├── demo/
│   ├── blackhole/                # 黑洞 Demo 产物 + Session 日志
│   └── mc/                       # MC 风格 Demo 产物
├── .github/workflows/publish.yml # v* 标签触发 npm 自动发布
├── scripts/
│   ├── analyze-session.mjs       # Session JSONL 轨迹词频分析器
│   ├── check.mjs                 # pnpm build 使用的语法检查脚本
│   └── install-preset.mjs        # postinstall：复制预设与内部包到 DSH 目录
├── packages/
│   ├── dsh-terminal-pwsh/        # PTY 后端包（node-pty/ConPTY）
│   │   └── lib/index.js
│   └── dsh-tool-pwsh-persistent/ # 模型侧持久 pwsh 工具包
│       └── lib/index.js
└── tests/
    ├── prompt-parity.mjs         # 提示面一致性（无需 PTY）
    ├── sandbox-escalation.mjs    # 提权 / 双路径行为
    └── sandbox-mode-switch.mjs   # 沙箱模式切换行为
```

## 开发与测试

仓库根目录已有用于 npm 发布的 `package.json`；本项目没有运行时构建步骤，`pnpm build` 只对包内 JS/MJS 做语法检查。测试仍是直接使用 Node 运行的脚本，从已安装的 DSH harness `node_modules` 导入依赖。

```bash
node tests/prompt-parity.mjs
```

`prompt-parity.mjs` 不需要 PTY，可在受限模式下运行。另外两个套件会启动真实的 ConPTY pwsh 会话，因此需要 `danger-full-access`：

```bash
node tests/sandbox-escalation.mjs
node tests/sandbox-mode-switch.mjs
```

先运行 `install.ps1`，确保两个包已出现在测试所引用的 harness `node_modules` 路径中。

## 文档

- [`packages/dsh-terminal-pwsh/README.md`](packages/dsh-terminal-pwsh/README.md)——后端设计与配置
- [`packages/dsh-tool-pwsh-persistent/README.md`](packages/dsh-tool-pwsh-persistent/README.md)——工具契约与已知 Windows 限制
- [`README.md`](README.md) — English version

## 许可证

本仓库（源码、测试、README 与 DSH 预设形态）以 **MIT License** 授权——见 [`LICENSE`](LICENSE)。

Copyright (c) 2026 Saikel-Orado-Liu aka GameGeek-Saikel
