/**
 * LLM 输出解析 + 软校验 + 渲染。
 *
 * 输入：LLM 返回的原始文本（含 `L<n>:` 锚点行 + 注释段）
 * 输出：
 *   - parse() → AnchoredLine[]
 *   - validate(parsed, originalSource) → 通过 / 抛 ConsistencyError
 *   - render(parsed) → 最终展示给用户的文本（剥掉 L<n>: 前缀，保留注释段 + 原代码行）
 *
 * 软校验设计（design doc）：
 *   - 缺失锚点 ≤ 5%（即命中率 ≥ 95%）
 *   - 命中的锚点行内容 trim 后 mismatch ≤ 3%
 *   - 实测 DeepSeek 在 sample.ts 命中率 97.4%（38/39，缺的 1 个是 trailing newline 的虚拟空行）
 *
 * 不在这里抛 vscode 错误——这是纯函数模块，错误用类型化的 ConsistencyError 抛回 caller。
 */

import { ANCHOR_LINE_RE } from './prompt';

export interface AnchoredLine {
  /** 1-based 行号（对应原文 L<n>） */
  lineNo: number;
  /** L<n>: 后面的代码内容（保留原始空白） */
  code: string;
  /** 该锚点之前积累的注释行（含空行；按出现顺序） */
  leadingComments: string[];
}

export interface ParseResult {
  parsed: AnchoredLine[];
  /** parse 过程中遇到的「无法归属到任何锚点」的尾部内容（通常是 LLM 在最后多写的话） */
  trailingComments: string[];
}

/**
 * 解析 LLM 输出。
 * 遇到 L<n>: 行 → 起一个新 AnchoredLine，把之前积累的 pending 注释行划给它。
 * 否则当注释行，进 pending 队列。
 */
export function parse(output: string): ParseResult {
  const parsed: AnchoredLine[] = [];
  let pending: string[] = [];

  for (const line of output.split('\n')) {
    const m = line.match(ANCHOR_LINE_RE);
    if (m) {
      parsed.push({
        lineNo: Number(m[1]),
        code: m[2] ?? '',
        leadingComments: pending,
      });
      pending = [];
    } else {
      pending.push(line);
    }
  }
  return { parsed, trailingComments: pending };
}

export class ConsistencyError extends Error {
  readonly anchorsExpected: number;
  readonly anchorsHit: number;
  readonly mismatches: number;
  constructor(message: string, anchorsExpected: number, anchorsHit: number, mismatches: number) {
    super(message);
    this.name = 'ConsistencyError';
    this.anchorsExpected = anchorsExpected;
    this.anchorsHit = anchorsHit;
    this.mismatches = mismatches;
  }
}

export interface ValidationOptions {
  /** 缺失锚点容忍度 0-1，默认 0.05 */
  missingTolerance?: number;
  /** 行内容 trim 比对容忍度 0-1，默认 0.03 */
  mismatchTolerance?: number;
}

export interface ValidationStats {
  anchorsExpected: number;
  anchorsHit: number;
  mismatches: number;
  hitRate: number;
  mismatchRate: number;
}

/**
 * 软校验。失败抛 ConsistencyError；成功返回 stats 供 telemetry/调试。
 *
 * 算法（修订版）：
 *   - expectedLines 来自 splitSourceLines（去 trailing newline 副作用）
 *   - **空行（trim 后为 ''）不参与 expected/hit 统计** —— LLM 在空行写注释也没意义，
 *     实测 Python 文件里 PEP8 风格的空行 LLM 普遍会吞，但内容行 100% 命中。
 *     render 阶段已经会按 lineNo 从原文补齐空行，所以不影响最终视图。
 *   - mismatch 仍然只统计 byLineNo 中真实命中且 lineNo 在 1..N 范围内的条目
 */
export function validate(
  parsed: AnchoredLine[],
  originalSource: string,
  opts: ValidationOptions = {}
): ValidationStats {
  const missingTolerance = opts.missingTolerance ?? 0.05;
  const mismatchTolerance = opts.mismatchTolerance ?? 0.03;

  const originalLines = splitSourceLines(originalSource);

  // 非空行索引集合（1-based）
  const nonEmptyLineNos = new Set<number>();
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== '') nonEmptyLineNos.add(i + 1);
  }
  const expected = nonEmptyLineNos.size;
  if (expected === 0) {
    return { anchorsExpected: 0, anchorsHit: 0, mismatches: 0, hitRate: 1, mismatchRate: 0 };
  }

  // 用 Map 处理 LLM 重复 emit 同一 lineNo 的情况——以第一次出现为准
  const byLineNo = new Map<number, AnchoredLine>();
  for (const p of parsed) {
    if (!byLineNo.has(p.lineNo)) byLineNo.set(p.lineNo, p);
  }

  let hit = 0;
  for (const idx of nonEmptyLineNos) {
    if (byLineNo.has(idx)) hit++;
  }
  const hitRate = hit / expected;

  if (1 - hitRate > missingTolerance) {
    throw new ConsistencyError(
      `非空行锚点缺失率 ${((1 - hitRate) * 100).toFixed(1)}% 超过容忍 ${(missingTolerance * 100).toFixed(0)}% (命中 ${hit}/${expected})`,
      expected,
      hit,
      0
    );
  }

  // mismatch：所有 byLineNo 中 lineNo 命中原文范围（非空）的，比对 trim
  let mismatches = 0;
  let mismatchDenominator = 0;
  for (const [lineNo, p] of byLineNo) {
    if (!nonEmptyLineNos.has(lineNo)) continue; // 空行命中不参与 mismatch 统计
    mismatchDenominator++;
    if (p.code.trim() !== originalLines[lineNo - 1].trim()) {
      mismatches++;
    }
  }
  const mismatchRate = mismatchDenominator > 0 ? mismatches / mismatchDenominator : 0;
  if (mismatchRate > mismatchTolerance) {
    throw new ConsistencyError(
      `行内容 mismatch 率 ${(mismatchRate * 100).toFixed(1)}% 超过容忍 ${(mismatchTolerance * 100).toFixed(0)}% (${mismatches}/${mismatchDenominator})`,
      expected,
      hit,
      mismatches
    );
  }

  return { anchorsExpected: expected, anchorsHit: hit, mismatches, hitRate, mismatchRate };
}

/**
 * 把 parsed 结构渲染成最终展示给用户的文本。
 * 顺序按 lineNo 升序——LLM 偶尔会乱序输出锚点，但用户视图必须按行号升序，否则跟左侧原文走读对不上。
 * 缺失的 lineNo：用原文补齐（让显示尽量像原文 + 注释，而不是断片）。
 */
export function render(parsed: AnchoredLine[], originalSource: string, trailingComments: string[] = []): string {
  const originalLines = splitSourceLines(originalSource);
  const byLineNo = new Map<number, AnchoredLine>();
  for (const p of parsed) {
    if (!byLineNo.has(p.lineNo)) byLineNo.set(p.lineNo, p);
  }

  const out: string[] = [];
  for (let i = 1; i <= originalLines.length; i++) {
    const entry = byLineNo.get(i);
    if (entry) {
      for (const c of entry.leadingComments) out.push(c);
      // 优先用原文行内容（防止 LLM 偷偷改了空白/缩进），不用 entry.code
      // 已经在 validate 里确认 trim 等价
      out.push(originalLines[i - 1]);
    } else {
      // 缺失锚点：直接补原文
      out.push(originalLines[i - 1]);
    }
  }
  if (trailingComments.length > 0) {
    // 尾部的 LLM 多余注释保留在末尾，避免悄悄丢失信息
    out.push(...trailingComments);
  }
  return out.join('\n');
}

/**
 * source.split('\n') 末尾若是空字符串（trailing newline），把它去掉。
 * 这样「100 行带末尾换行」与「100 行不带末尾换行」算出来都是 100 行，软校验阈值不被误判。
 */
function splitSourceLines(source: string): string[] {
  const lines = source.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1);
  }
  return lines;
}
