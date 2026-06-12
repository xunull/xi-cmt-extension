# TODOS

Post-ship and deferred items tracked here. Items are added by CEO/Eng reviews and removed when resolved.

---

## v0.1.x (active sprint)

- [ ] **[PRE-IMPL BLOCKER]** 实现 chunker 前：手动测 DeepSeek 2 并发请求是否触发 rate-limit 或乱序响应，失败则默认降级为串行（只改 semaphore 初始值）
- [ ] **[IMPL DETAIL]** extension.ts 中注册 `onDidSaveTextDocument` 监听器时，必须把返回值加入 `context.subscriptions`，防止 deactivate 后内存泄漏

---

## 上线后验收

- [ ] **[CALIBRATION]** 分块上线后，用 5-10 个真实大文件（≥ 1000 行）验证软校验通过率：行锚命中率 ≥ 95% 是否需要调整（分块场景 LLM context 受限，通过率可能偏低）
- [ ] **[CACHE]** 评估 `.vscode/.cmt-cache/` LRU 清理策略：v0.1.x 测试期间反复跑大文件后，检查目录大小，决定是否需要实现自动过期/清理脚本

---

## UX 改进

- [ ] **[PROVIDER-UX]** 加 `xi-cmt: Configure Provider` 命令：弹 QuickPick 列表选厂商（DeepSeek / OpenAI / Moonshot / SiliconFlow / 阿里云百炼 / Ollama），选后自动联动写入 `baseURL` + `model` 默认值，再提示输入 API Key。纯下拉框不可行（设置项无联动逻辑，选完 baseURL 后 model 仍是旧值会导致报错）。约 50 行代码。

---

## 按需扩展

- [ ] **[CHUNKER]** 根据用户反馈扩展 `chunker.ts` 语言语义切分支持。当前：TS/JS/Go/Python/Rust。待扩展候选：C/C++、Java、PHP、Ruby、Swift、Kotlin（降级到均等切分不会出错，但切分质量更低）

---

## Deferred to V2

- 分块缓存 LRU 清理（自动过期机制，参见上方「上线后验收」跟踪项）
- 多视角注释（解读视角 vs 实现视角）
- 跨文件 callers/callees 联动注释
- Anthropic 原生 Provider（用户不需要，明确 Cut）
