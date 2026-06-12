# xi-cmt — 中文源码注释阅读副本

一键在 VS Code 里为当前文件生成**详细中文注释副本**并排打开。注释风格是 Why+How 型——解释**为什么这么写、防什么 bug、调用关系**，不是「这是一个函数」这种 AI 废话。

不修改原文件，副本在 `xi-cmt:` 虚拟 scheme 里，关闭再开走缓存秒开。

## 为什么不直接用 Copilot Chat / Cursor

- **持久化阅读副本**：Copilot Chat / Cursor 的解释是 chat 流，关掉就没了，下次问要重新生成；xi-cmt 把注释版当成「同名带注释的文件」打开，可走动、可反复回看，关掉再开秒开（缓存按文件内容 hash）
- **左原文 / 右注释版双列并排**：像读双语对照书一样读源码
- **专为中文调优的 Why+How 提示词**：注释解释「为什么这么写」，不是「这一行做什么」
- **多 LLM 后端自由切换**：OpenAI Chat Completions 兼容协议覆盖 OpenAI / DeepSeek / Moonshot / SiliconFlow / Ollama，你自带 key，扩展不绑定 Copilot

## 安装

V1 阶段只发 GitHub Release（Marketplace 待 V1.0.1）：

```bash
# 1. 下载最新 .vsix
gh release download -R xunull/xi-cmt-extension --pattern '*.vsix'

# 2. 安装
code --install-extension xi-cmt-*.vsix
```

或在 VS Code 里：扩展面板 → `...` → `Install from VSIX...` → 选 `.vsix`。

## 本地构建 / 参与开发

**前置要求**：Node.js ≥ 18、npm

```bash
# 1. 克隆仓库
git clone https://github.com/xunull/xi-cmt-extension.git
cd xi-cmt-extension

# 2. 安装依赖（含 @vscode/vsce 打包工具）
npm install

# 3. 编译 TypeScript → out/
npm run compile

# 4. 打包成 .vsix（会自动先执行 vscode:prepublish 即重新编译）
npm run package
# 产物：xi-cmt-<version>.vsix

# 5. 安装到本地 VS Code
code --install-extension xi-cmt-*.vsix
```

**开发调试**：用 VS Code 打开仓库，按 `F5` 启动扩展开发宿主（Extension Development Host），实时调试无需打包。

## 快速开始

1. 命令面板（`Cmd+Shift+P` / `Ctrl+Shift+P`）→ `xi-cmt: Set API Key` → 粘贴你的 DeepSeek API Key（[免费注册 deepseek.com](https://platform.deepseek.com)，新用户送额度，单文件大概 ¥0.01）
2. 打开任意源码文件
3. 命令面板 → `xi-cmt: Open Annotated Preview`（或编辑器右上角点 📖 按钮）
4. 右侧 column 打开同名 `.cmt.<ext>` 副本，注释**流式**逐段填进来
5. 关闭再打开 → 走缓存秒开，不再消耗 token

## 命令

| 命令 | 作用 |
|------|------|
| `xi-cmt: Open Annotated Preview` | 把当前文件以「中文注释副本」打开在右侧 |
| `xi-cmt: Regenerate Annotation` | 在 .cmt 文档上重新生成（清掉该文件的缓存） |
| `xi-cmt: Set API Key` | 通过 SecretStorage（OS keychain 加密）存 API Key |
| `xi-cmt: Clear Cache` | 清掉所有 .cmt 缓存（workspace + 全局） |

## 配置

`Cmd+,` → 搜 `xi-cmt`，或 `settings.json`：

```jsonc
{
  // OpenAI Chat Completions 兼容 /v1/chat/completions 的根路径
  "xi-cmt.baseURL": "https://api.deepseek.com/v1",
  // 模型名
  "xi-cmt.model": "deepseek-chat",
  // 注释语言：MVP 仅测试 zh-CN
  "xi-cmt.commentLanguage": "zh-CN",
  // 缓存位置：'project' (随项目走) 或 'user' (~/.cache/xi-cmt/)
  "xi-cmt.cacheMode": "project",
  // 单文件最大行数，超出报错不调 LLM
  "xi-cmt.maxLines": 1500,
  // LLM 请求超时（毫秒）
  "xi-cmt.requestTimeoutMs": 120000
}
```

**API Key 不进 settings.json**——走 SecretStorage，OS keychain 加密。用 `xi-cmt: Set API Key` 命令设置。

## Provider 配置范例

### DeepSeek（推荐：快、便宜、注释质量高）

```jsonc
{
  "xi-cmt.baseURL": "https://api.deepseek.com/v1",
  "xi-cmt.model": "deepseek-chat"
}
```

### Moonshot (Kimi)

```jsonc
{
  "xi-cmt.baseURL": "https://api.moonshot.cn/v1",
  "xi-cmt.model": "moonshot-v1-32k"
}
```

### SiliconFlow

```jsonc
{
  "xi-cmt.baseURL": "https://api.siliconflow.cn/v1",
  "xi-cmt.model": "Qwen/Qwen2.5-Coder-32B-Instruct"
}
```

### Ollama 本地（无需 API Key）

```jsonc
{
  "xi-cmt.baseURL": "http://localhost:11434/v1",
  "xi-cmt.model": "qwen2.5-coder:7b",
  "xi-cmt.requestTimeoutMs": 180000
}
```

> Ollama 检测到 `localhost / 127.0.0.1 / 0.0.0.0` 时自动跳过 API Key 校验。

### OpenAI

```jsonc
{
  "xi-cmt.baseURL": "https://api.openai.com/v1",
  "xi-cmt.model": "gpt-4o-mini"
}
```

## 缓存策略

- `cacheMode: "project"`（默认）：缓存写在 `<workspace>/.vscode/.cmt-cache/`
- `cacheMode: "user"`：缓存写在 `~/.cache/xi-cmt/`

**Cache key 公式**：`sha256(file_content).slice(0, 16) + "." + model + "." + promptVersion`

意味着以下任一变化都会重新生成、不会读旧缓存：
- 源文件内容改了
- 切了 model（如 deepseek-chat → moonshot-v1-32k）
- 扩展升级 bump 了 promptVersion

### .gitignore 建议

`.vscode/.cmt-cache/` 默认**不要入 git**——多人协作时 model 不同会污染缓存。在仓库 `.gitignore` 加一行：

```
.vscode/.cmt-cache/
```

如果你是一个人用、想跨设备同步缓存，把这行去掉即可。

## 工作原理（简版）

1. 提取当前文件源码，每行加 `L<n>: ` 行号锚点喂给 LLM
2. Prompt 强约束 LLM：保留每个 `L<n>:` 锚点行不动，在锚点上方插中文 Why+How 注释段
3. SSE 流式接收 → 节流 200ms 刷新右侧 buffer，肉眼看注释从上往下逐段生长
4. 流完跑软校验（非空行命中率 ≥ 95% + 行内容 mismatch ≤ 3%），剥锚点前缀渲染最终视图
5. 原子写到 `.vscode/.cmt-cache/<key>.cmt`，第二次打开直接读盘

全局并发限制 ≤ 2，防止你连点多个文件被 DeepSeek 限流。

## Troubleshooting

### 「远程 baseURL 需要 API Key」

→ 运行 `xi-cmt: Set API Key` 设置。或 baseURL 改成 Ollama 本地。

### 「model 不存在或 endpoint 错误」

→ 检查 `xi-cmt.model` 是否匹配 `xi-cmt.baseURL` 的供应商；DeepSeek 的 model 不能填到 Moonshot 的 baseURL 下。

### 「LLM 输出软校验失败」

LLM 没遵守 `L<n>:` 锚点格式（罕见）。点弹窗 `[重试]` 通常解决。反复失败：切换 model（推荐 `deepseek-chat` / `kimi-k2-0711-preview` / `qwen2.5-coder:7b`）。

### 「请求超时」

把 `xi-cmt.requestTimeoutMs` 调高（180000 = 3 分钟）。Ollama 本地大模型或 DeepSeek thinking 模型可能需要。

### 大文件支持

V1 单文件 hard limit 1500 行。超出会拒绝调 LLM 并提示。V1.x 加分块后再放宽。

## Roadmap

- **v0.1.x**：流式输出优化、行锚精确同步滚动、Anthropic 原生 provider
- **v0.2.0**：发到 VS Code Marketplace
- **v1.x**：多视角注释（新人视角 / 安全审计 / 性能分析 / 重构建议）、跨文件 callers/callees 联动、仓库批量生成

## 隐私

- **API Key** 走 OS keychain（VS Code SecretStorage），不进 settings.json
- **源代码** 会发到你配置的 `xi-cmt.baseURL`——使用 Ollama 本地完全离线
- 扩展本身**不收集任何遥测**，没有第三方依赖

## License

MIT — 见 [LICENSE](./LICENSE)
