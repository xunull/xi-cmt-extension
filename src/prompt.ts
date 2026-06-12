/**
 * 提示词模板 + 行号锚点编解码。
 *
 * 设计要点（design doc 锁定）：
 *   - 给 LLM 喂代码时每行加 `L<n>: ` 前缀，强制 LLM 按行号对齐输出
 *   - 注释段写在锚点行**上方**，可多行
 *   - 输出严格保留 `L<n>:` 锚点行 → Step 3 parser 能解析
 *
 * 预设风格：
 *   - expert（默认）：Why+How，读者熟悉语言但不熟悉代码库
 *   - beginner：What+Why+How，读者正在学习该语言
 *   - architect：设计决策+架构视角，读者评估代码质量
 *   - custom：用户自定义完整 system prompt
 *
 * promptVersion 用于 cache key；预设文本非平凡改动时 bump。
 */

export const PROMPT_VERSION = 'v0.1.1';

export type PromptPreset = 'expert' | 'beginner' | 'architect' | 'custom';

export interface PromptOptions {
  /** vscode 的 languageId，例如 'typescript' / 'go' / 'python' */
  languageId: string;
  /** 注释语言：'zh-CN' | 'en-US'，MVP 仅测试 zh-CN */
  commentLanguage: string;
  /** 注释风格预设，默认 'expert' */
  promptPreset: PromptPreset;
  /** preset=custom 时生效：用户自定义的完整 system prompt */
  customPrompt?: string;
}

/** 行号锚点正则：用于 Step 3 parser 与本文件 strip。多保留一份避免漂移。 */
export const ANCHOR_LINE_RE = /^L(\d+): ?(.*)$/;

/** 把原代码每行加 `L<n>: ` 前缀。空行也加，保持行号连续。 */
export function addLineNumbers(source: string): string {
  const lines = source.split('\n');
  return lines.map((line, i) => `L${i + 1}: ${line}`).join('\n');
}

/** 简单 strip：每行去掉开头 `L<n>: `（如果有）。Step 3 parser 是更严格的版本。 */
export function stripLineNumbers(output: string): string {
  return output
    .split('\n')
    .map((line) => line.replace(ANCHOR_LINE_RE, '$2'))
    .join('\n');
}

// ─── 各预设的角色 + 注释原则（可变部分）────────────────────────────────────────

const PRESET_ROLE: Record<Exclude<PromptPreset, 'custom'>, (langName: string) => string> = {
  expert: (langName) => [
    `你是一名资深工程师，专门为${langName}开发者阅读不熟悉的源码生成「Why + How」型深度注释。`,
    '',
    '## 读者预设',
    '读者是有经验的开发者，熟悉该语言，但不熟悉这段代码库。不需要解释语法；需要解释决策、约束、非显然行为、潜在陷阱。',
    '',
    '## 注释原则',
    `写什么：Why（为什么这样设计而非显而易见的替代方案）、How（关键实现细节、调用关系）、防御（防什么 bug / 处理什么边界）、代价（性能取舍、副作用）、假设（依赖哪些前置条件）。`,
    '',
    `废话过滤器：不翻译代码（return result → ❌"返回结果"）；不重复标识符（userList = [] → ❌"初始化用户列表"）；不解释熟悉该语言者都懂的语法。`,
    '',
    '## 注释时机（选择性注释，不是每行都注）',
    '优先：函数首行（目的+副作用+错误策略）、非显然算法选型、魔法数字、workaround、并发关键点、错误兜底路径。',
    '可跳过：简单赋值、明显的 getter/setter、trivial 类型转换。',
  ].join('\n'),

  beginner: (langName) => [
    `你是一名耐心的技术导师，帮助初学者读懂不熟悉的源码，注释使用${langName}。`,
    '',
    '## 读者预设',
    '读者正在学习该编程语言，可能不熟悉常见设计模式和惯用写法。请用通俗易懂的语言解释代码的作用、实现方式和背后原理。',
    '',
    '## 注释原则',
    '写什么：What（这段代码在做什么）、Why（为什么需要，解决了什么问题）、How（关键步骤如何实现）。',
    '如果用到了设计模式、算法或特定语言特性，点名并简要解释其含义。',
    '',
    '废话过滤器：不要逐字翻译代码；注释要比代码本身提供更多信息。',
    '',
    '## 注释时机',
    '尽量为每个函数、重要逻辑块和不明显的代码段添加注释；宁可多注释也不要遗漏。',
  ].join('\n'),

  architect: (langName) => [
    `你是一名系统架构师，从架构视角为代码提供设计层面的${langName}注释，帮助工程师评估代码质量与演进空间。`,
    '',
    '## 读者预设',
    '读者是资深工程师或架构师，评估代码的设计质量、可维护性和演进能力。聚焦架构决策，跳过实现细节。',
    '',
    '## 注释原则',
    '写什么：模块职责与系统边界、设计决策的取舍与动机、与外部模块的耦合及风险、对常见需求变更的适应能力、技术债信号（脆弱假设、隐式约束、需要重构的迹象）。',
    '',
    '不写什么：逐行实现细节、对有经验者显而易见的语法说明。',
    '',
    '## 注释时机',
    '重点注释：文件/模块入口、公共 API 边界、关键设计决策点、技术债累积处、并发 / 事务 / 安全边界。',
    '可跳过：内部工具函数的实现细节，除非有非显然约束。',
  ].join('\n'),
};

// ─── 固定输出规则（所有预设共享）────────────────────────────────────────────────

function buildAnchorRules(langName: string): string {
  return [
    '## 输入格式',
    '用户会给你一段代码，每行已加上 `L<行号>: ` 前缀（例如 `L42: function add(a, b) {`）。',
    '',
    '## 输出要求（必须严格遵守）',
    '1. 每一个 `L<行号>:` 锚点行**原样保留**，包括行号和后面的全部代码字符；空白、缩进、空行的锚点也要原样保留。',
    `2. 在需要注释的 \`L<行号>:\` 锚点行**上方**插入 \`// ${langName}注释\`，可以多行。`,
    '3. **不要修改、删除、合并、重排任何 `L<行号>:` 后面的代码字符**。',
    '4. 不要在输出里添加 markdown 代码块包裹（不要 ```），直接输出带注释的代码。',
    '5. 注释行不要加 `L<行号>:` 前缀——锚点前缀只用于代码行。',
    '',
    '## 输出示例',
    '输入:',
    'L1: function add(a, b) {',
    "L2:   if (typeof a !== 'number') throw new TypeError('a must be number')",
    'L3:   return a + b',
    'L4: }',
    '',
    '输出:',
    '// 数值加法工具',
    '// Why: 显式类型检查防止 JS 隐式类型转换造成 NaN，让调用方在编译期就能发现错误',
    '// How: 只校验 a 不校验 b——调用约定要求 b 由调用方保证类型正确',
    'L1: function add(a, b) {',
    '// Why: throw TypeError 而非返回 NaN——让上游 catch 块能区分「类型错」和「计算错」',
    "L2:   if (typeof a !== 'number') throw new TypeError('a must be number')",
    'L3:   return a + b',
    'L4: }',
  ].join('\n');
}

/**
 * 构建实际发给 LLM 的 system prompt。
 * preset=custom 时直接返回用户提供的文本（锚点约束在 user prompt 里，不依赖 system prompt）。
 */
export function buildSystemPrompt(opts: PromptOptions): string {
  const langName = opts.commentLanguage === 'zh-CN' ? '中文' : 'English';
  if (opts.promptPreset === 'custom') {
    return opts.customPrompt?.trim() || PRESET_ROLE.expert(langName);
  }
  return [PRESET_ROLE[opts.promptPreset](langName), '', buildAnchorRules(langName)].join('\n');
}

export function buildUserPrompt(source: string, opts: PromptOptions): string {
  const numbered = addLineNumbers(source);
  const langName = opts.commentLanguage === 'zh-CN' ? '中文' : 'English';
  return [
    `请为以下 ${opts.languageId} 代码生成${langName} Why+How 注释。严格保留每一个 L<n>: 锚点行（包括其后的全部代码字符），并在合适位置上方插入注释段。`,
    '',
    numbered,
  ].join('\n');
}

/**
 * 分块模式的 user prompt。行号从 L1: 开始（块内相对行号），validate/render 也用块内坐标。
 * chunkInfo 提供进度提示，帮助 LLM 理解这是大文件的一段。
 */
export function buildChunkUserPrompt(
  chunkContent: string,
  chunkInfo: { index: number; total: number },
  opts: PromptOptions
): string {
  const numbered = addLineNumbers(chunkContent);
  const langName = opts.commentLanguage === 'zh-CN' ? '中文' : 'English';
  const chunkNote =
    chunkInfo.total > 1
      ? `（文件共 ${chunkInfo.total} 段，这是第 ${chunkInfo.index + 1} 段）`
      : '';
  return [
    `请为以下 ${opts.languageId} 代码生成${langName} Why+How 注释${chunkNote}。严格保留每一个 L<n>: 锚点行（包括其后的全部代码字符），并在合适位置上方插入注释段。`,
    '',
    numbered,
  ].join('\n');
}
