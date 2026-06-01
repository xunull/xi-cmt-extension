/**
 * 提示词模板 + 行号锚点编解码。
 *
 * 设计要点（design doc 锁定）：
 *   - 给 LLM 喂代码时每行加 `L<n>: ` 前缀，强制 LLM 按行号对齐输出
 *   - 注释段写在锚点行**上方**，可多行
 *   - 输出严格保留 `L<n>:` 锚点行 → Step 3 parser 能解析
 *   - 风格：Why+How，不是 What
 *
 * promptVersion 用于 cache key 一部分；当本文件的 prompt 文本有非平凡改动时 bump。
 */

export const PROMPT_VERSION = 'v0.1.0-step2';

export interface PromptOptions {
  /** vscode 的 languageId，例如 'typescript' / 'go' / 'python' */
  languageId: string;
  /** 注释语言：'zh-CN' | 'en-US'，MVP 仅测试 zh-CN */
  commentLanguage: string;
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

export function buildSystemPrompt(opts: PromptOptions): string {
  const langName = opts.commentLanguage === 'zh-CN' ? '中文' : 'English';
  return [
    `你是一名资深工程师，专门为${langName}开发者阅读不熟悉的源码生成「Why + How」型详细注释。`,
    '',
    '## 输入格式',
    '用户会给你一段代码，每行已加上 `L<行号>: ` 前缀（例如 `L42: function add(a, b) {`）。',
    '',
    '## 输出要求（必须严格遵守）',
    '1. 每一个 `L<行号>:` 锚点行**原样保留**，包括行号和后面的全部代码字符；空白、缩进、空行的锚点也要原样保留。',
    '2. 在每个逻辑段（函数 / 复杂表达式 / 分支 / 循环 / 重要赋值 / 关键 import）的 `L<行号>:` 锚点行**上方**插入 `// ${langName}注释`，可以多行。',
    `3. 注释风格是「Why + How」型——解释**为什么这么写、防什么 bug、调用关系、设计权衡**，不要写「这是一个函数」「这一行返回一个值」这类废话。`,
    '4. **不要修改、删除、合并、重排任何 `L<行号>:` 后面的代码字符**。',
    '5. 不要在输出里添加 markdown 代码块包裹（不要 ```），直接输出带注释的代码。',
    '6. 注释行不要加 `L<行号>:` 前缀——锚点前缀只用于代码行。',
    '',
    '## 输出示例',
    '输入:',
    'L1: function add(a, b) {',
    "L2:   if (typeof a !== 'number') throw new TypeError('a must be number')",
    'L3:   return a + b',
    'L4: }',
    '',
    '输出:',
    '// 数值加法函数',
    '// Why: 显式类型检查防止 JS 隐式类型转换造成 NaN',
    '// How: 只校验 a 不校验 b——已知调用方保证 b 已经是 number',
    'L1: function add(a, b) {',
    '// Why: throw TypeError 而非返回 NaN——让上游 catch 块能区分「类型错」与「计算错」',
    "L2:   if (typeof a !== 'number') throw new TypeError('a must be number')",
    'L3:   return a + b',
    'L4: }',
  ].join('\n');
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
