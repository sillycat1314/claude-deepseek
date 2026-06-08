# Claude Code + DeepSeek V4 Pro

让 Claude Code 通过 DeepSeek V4 Pro 运行，无需 Anthropic API Key。

## 一键部署

```powershell
git clone https://github.com/YOUR_USER/claude-deepseek.git
cd claude-deepseek
powershell -ExecutionPolicy Bypass -File setup.ps1
```

## 使用

**方法 1（推荐）：** 双击 `launch.bat`

**方法 2：** 先启动代理，再开 Claude Code
```powershell
# 终端 1：启动代理
node proxy.mjs

# 终端 2：启动 Claude Code
set ANTHROPIC_BASE_URL=http://127.0.0.1:8384
set ANTHROPIC_API_KEY=deepseek-proxy
claude --dangerously-skip-permissions
```

## 工作原理

```
Claude Code --> proxy.mjs (127.0.0.1:8384) --> DeepSeek API
                    |
                    | Anthropic API -> OpenAI Chat Completions
                    | 模型: deepseek-v4-pro
                    | 自动过滤推理内容
                    v
              DeepSeek V4 Pro
```

- `ANTHROPIC_BASE_URL` 指向本地代理
- 代理翻译 Anthropic Messages API -> OpenAI Chat Completions
- 支持 27 个 Claude Code 工具
- 自动过滤 V4 Pro reasoning_content
- hosts 劫持 platform.claude.com 绕过 GFW

## 系统要求

- Windows 10/11 + Node.js 18+
- `npm i -g @anthropic-ai/claude-code`

## 文件说明

| 文件 | 用途 |
|------|------|
| `proxy.mjs` | 核心代理 |
| `launch.bat` | 一键启动 |
| `setup.ps1` | 安装脚本 |
| `README.md` | 本文件 |

## FAQ

**连接失败？** 确保代理 8384 端口已启动，env 变量已设置。

**证书错误？** launch.bat 已包含跳过证书检查，如仍有问题检查 hosts 文件。

**模型？** 默认 deepseek-v4-pro，可在 proxy.mjs MODEL_MAP 中修改。
