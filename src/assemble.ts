/**
 * assembleChunks：把多块 LLM 渲染结果拼接成完整文件，同时丢弃 overlap 上下文行。
 *
 * 每块的 LLM 输入是 lines[contextStart..endLine]（含 overlap 前缀）。
 * overlap 行（contextStart .. startLine-1）只作为 LLM 理解上下文，不出现在最终输出。
 *
 * 纯函数，不依赖 VS Code API，便于单元测试（assembleChunks.test.ts）。
 */

import type { Chunk } from './chunker';

export interface AnnotatedChunk {
  /** renderWithLinemap 产出的注释文本（对应 contextStart..endLine 的内容） */
  content: string;
  /**
   * [annotatedLine0 in content, chunkLine0] 对。
   * annotatedLine0：在 content 中的 0-based 行号（注释行会偏移代码行）。
   * chunkLine0：chunk content 内部的 0-based 行号（对应原文 contextStart + chunkLine0）。
   */
  pairs: [number, number][];
  chunk: Chunk;
}

export interface AssembledResult {
  content: string;
  /** [globalAnnotatedLine0, globalOriginalLine0]，均 0-based，供 linemap sidecar 使用 */
  globalPairs: [number, number][];
}

/**
 * 把各块渲染结果拼接，丢弃 overlap，构建全局行号映射。
 *
 * 块 0：直接全部保留。
 * 块 N：找第一个 chunkLine0 >= overlapLineCount 的注释行，从该行起截取。
 */
export function assembleChunks(annotatedChunks: AnnotatedChunk[]): AssembledResult {
  const outputLines: string[] = [];
  const globalPairs: [number, number][] = [];

  for (const { content, pairs, chunk } of annotatedChunks) {
    const contentLines = content.split('\n');
    const overlapLineCount = chunk.startLine - chunk.contextStart;

    let cutLocalAnn: number;
    if (overlapLineCount === 0) {
      cutLocalAnn = 0;
    } else {
      const cutPair = pairs.find(([, local]) => local >= overlapLineCount);
      cutLocalAnn = cutPair !== undefined ? cutPair[0] : contentLines.length;
    }

    const globalOffset = outputLines.length;
    outputLines.push(...contentLines.slice(cutLocalAnn));

    for (const [localAnn, local] of pairs) {
      if (localAnn >= cutLocalAnn) {
        globalPairs.push([
          localAnn - cutLocalAnn + globalOffset,
          chunk.contextStart + local,
        ]);
      }
    }
  }

  return { content: outputLines.join('\n'), globalPairs };
}
