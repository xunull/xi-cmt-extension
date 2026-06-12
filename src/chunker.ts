/**
 * 语义分块：把源码按顶层边界切成 ≤ 500 行的块。
 *
 * 每块包含 30 行 overlap context（来自上一块末尾），作为 LLM 理解连续性的上下文。
 * overlap 行只送入 LLM，不出现在最终合并输出（assembleChunks 负责去重）。
 *
 * 切分策略：
 *   1. 按顶层 function/class/export/def/impl/fn 正则识别语义边界
 *   2. 若单块 > maxChunkSize，递归均等切分（fallback）
 *   3. 单块 ≤ maxChunkSize：直接整体作为 1 块（常见场景）
 */

export const OVERLAP_LINES = 30;
export const MAX_CHUNK_SIZE = 500;

/**
 * startLine / endLine：0-based，指向原始 source lines 数组下标（inclusive）。
 * contextStart：LLM 实际收到的起始行（= max(0, startLine - OVERLAP_LINES)）。
 * 调用方从 lines[contextStart..endLine] 构建 LLM 输入；
 * 合并时只保留 lineNo >= startLine 的 LLM 输出。
 */
export interface Chunk {
  index: number;
  startLine: number;
  endLine: number;
  contextStart: number;
}

/** 匹配顶层语义边界（各语言的顶层 function / class / export / impl 起始行） */
const SEMANTIC_BOUNDARY_RE =
  /^(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|abstract\s+class|interface|type|enum)\b|(?:async\s+)?function\s+\w|class\s+\w|def\s+\w|fn\s+\w|pub\s+(?:async\s+)?fn\s+\w|impl\b|pub\s+struct\s+\w|pub\s+enum\s+\w|func\s+\w)/;

export function splitBySemanticBoundary(lines: string[], maxChunkSize: number = MAX_CHUNK_SIZE): Chunk[] {
  if (lines.length === 0) return [];
  if (lines.length <= maxChunkSize) {
    return [{ index: 0, startLine: 0, endLine: lines.length - 1, contextStart: 0 }];
  }

  const boundaries = findSemanticBoundaries(lines, maxChunkSize);
  const rawChunks = boundariesToRanges(boundaries, lines.length);
  const expanded = expandOverflows(rawChunks, maxChunkSize);
  return assignContext(expanded);
}

/** 找所有语义边界行号（0-based），过滤到不超过 maxChunkSize 间距 */
function findSemanticBoundaries(lines: string[], maxChunkSize: number): number[] {
  const boundaries: number[] = [0];
  let lastBoundary = 0;

  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (SEMANTIC_BOUNDARY_RE.test(trimmed)) {
      if (i - lastBoundary >= Math.floor(maxChunkSize * 0.5)) {
        boundaries.push(i);
        lastBoundary = i;
      }
    }
    // 强制边界：如果距离上次边界已超过 maxChunkSize，在这里强制切分
    if (i - lastBoundary >= maxChunkSize) {
      boundaries.push(i);
      lastBoundary = i;
    }
  }
  return boundaries;
}

/** 把边界数组变成 [startLine, endLine] 对 */
function boundariesToRanges(boundaries: number[], totalLines: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] - 1 : totalLines - 1;
    ranges.push([start, end]);
  }
  return ranges;
}

/** 若某范围仍超过 maxChunkSize，均等切分（fallback） */
function expandOverflows(ranges: Array<[number, number]>, maxChunkSize: number): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const size = end - start + 1;
    if (size <= maxChunkSize) {
      result.push([start, end]);
    } else {
      const parts = Math.ceil(size / maxChunkSize);
      const partSize = Math.ceil(size / parts);
      for (let p = 0; p < parts; p++) {
        const s = start + p * partSize;
        const e = Math.min(s + partSize - 1, end);
        result.push([s, e]);
      }
    }
  }
  return result;
}

/** 给每个范围分配 index + contextStart */
function assignContext(ranges: Array<[number, number]>): Chunk[] {
  return ranges.map(([startLine, endLine], i) => ({
    index: i,
    startLine,
    endLine,
    contextStart: Math.max(0, startLine - OVERLAP_LINES),
  }));
}
