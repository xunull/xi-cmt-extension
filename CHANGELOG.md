# Changelog

## [0.1.0] — 2026-05-31（GitHub Release）

首个 ship 版本。范围：单文件 + 流式 + 缓存 + OpenAI 兼容协议。

### Added
- 命令 `xi-cmt: Open Annotated Preview`：一键在右侧 column 打开当前文件的中文注释副本
- 命令 `xi-cmt: Regenerate Annotation`：在 cmt 文档上重新生成（清掉该文件缓存）
- 命令 `xi-cmt: Set API Key`：通过 VS Code SecretStorage（OS keychain）存 API Key
- 命令 `xi-cmt: Clear Cache`：清掉所有 .cmt 缓存
- `xi-cmt:` 虚拟 scheme + `TextDocumentContentProvider`，避免修改原文件
- 流式渲染：节流 200ms 刷新，肉眼可见注释从上往下逐段生长
- 文件级缓存：`sha256(content) + model + promptVersion` 作 key，原子写到 `.vscode/.cmt-cache/`
- 7 类 LLM 错误分类（auth / model_not_found / quota / timeout / network / response_shape / invalid_config）+ 弹窗一键修复按钮
- 软校验：非空行锚点命中率 ≥ 95% + 行内容 mismatch ≤ 3%
- 并发限流：全局 semaphore（max=2）防止多文件触发限流
- Ollama 本地无 key 路径（baseURL 含 localhost / 127.0.0.1 自动跳过 key 校验）
- 已知兼容 provider：OpenAI / DeepSeek / Moonshot / SiliconFlow / Ollama

### Architecture
- 零运行时第三方依赖（fetch / crypto / fs 全用 Node 内置）
- engines.vscode `^1.85.0`，engines.node `>=18`

### Known Limitations（V1 范围内不修）
- 单文件 hard limit 1500 行
- 不做跨文件 callers/callees 联动（V2）
- 不做仓库批量生成（V2）
- Anthropic 原生 provider 暂不支持（必须用 deepseek/openai/ollama 之类 OpenAI 兼容代理）
- 同步滚动是「大致对照」非「行号 1:1 精确同步」（README 已说明）
