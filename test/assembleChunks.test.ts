import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assembleChunks, AnnotatedChunk } from '../src/assemble';
import type { Chunk } from '../src/chunker';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeChunk(
  index: number,
  startLine: number,
  endLine: number,
  contextStart: number
): Chunk {
  return { index, startLine, endLine, contextStart };
}

/**
 * 构造无注释的简单 AnnotatedChunk。
 * lines: 原文行内容（对应 chunkLine0 = 0,1,2...）。
 * pairs: [[annotated0, chunkLine0], ...]（无注释时 annotated0 = chunkLine0）。
 */
function simpleChunk(
  chunk: Chunk,
  lines: string[]
): AnnotatedChunk {
  return {
    content: lines.join('\n'),
    pairs: lines.map((_, i) => [i, i] as [number, number]),
    chunk,
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('assembleChunks', () => {
  test('单块：直接原样输出', () => {
    const chunk = makeChunk(0, 0, 4, 0);
    const lines = ['A', 'B', 'C', 'D', 'E'];
    const { content, globalPairs } = assembleChunks([simpleChunk(chunk, lines)]);

    assert.equal(content, 'A\nB\nC\nD\nE');
    assert.deepEqual(globalPairs, [
      [0, 0], [1, 1], [2, 2], [3, 3], [4, 4],
    ]);
  });

  test('两块无 overlap（块 1 contextStart === startLine）', () => {
    const c0 = makeChunk(0, 0, 2, 0);
    const c1 = makeChunk(1, 3, 5, 3); // contextStart = startLine → overlapLineCount=0

    const { content, globalPairs } = assembleChunks([
      simpleChunk(c0, ['A', 'B', 'C']),
      simpleChunk(c1, ['D', 'E', 'F']),
    ]);

    assert.equal(content, 'A\nB\nC\nD\nE\nF');
    assert.deepEqual(globalPairs, [
      [0, 0], [1, 1], [2, 2],   // chunk 0
      [3, 3], [4, 4], [5, 5],   // chunk 1
    ]);
  });

  test('两块有 1 行 overlap：块 1 头部重叠行被丢弃', () => {
    // chunk 1: contextStart=2, startLine=3 → overlapLineCount=1
    // chunk 1 content = lines[2..4] = [C, D, E]
    // 丢弃 chunkLine0=0（C），保留 chunkLine0=1 起（D,E）
    const c0 = makeChunk(0, 0, 2, 0);
    const c1 = makeChunk(1, 3, 4, 2);

    const { content, globalPairs } = assembleChunks([
      simpleChunk(c0, ['A', 'B', 'C']),
      simpleChunk(c1, ['C', 'D', 'E']), // C 是 overlap
    ]);

    assert.equal(content, 'A\nB\nC\nD\nE');
    assert.deepEqual(globalPairs, [
      [0, 0], [1, 1], [2, 2],  // chunk 0
      [3, 3], [4, 4],           // chunk 1（globalOrig = contextStart + local = 2+1=3, 2+2=4）
    ]);
  });

  test('两块有 30 行 overlap（标准场景）', () => {
    // chunk 0: 行 0-499（无 overlap）
    // chunk 1: contextStart=470, startLine=500, endLine=529（30 行 overlap + 30 行正文）
    const N0 = 500;
    const OVERLAP = 30;
    const N1_MAIN = 30;
    const N1 = OVERLAP + N1_MAIN; // 60 行

    const c0 = makeChunk(0, 0, N0 - 1, 0);
    const c1 = makeChunk(1, N0, N0 + N1_MAIN - 1, N0 - OVERLAP); // startLine=500, contextStart=470

    const lines0 = Array.from({ length: N0 }, (_, i) => `L${i}`);
    const lines1 = Array.from({ length: N1 }, (_, i) => `L${N0 - OVERLAP + i}`); // L470..L529

    const { content, globalPairs } = assembleChunks([
      simpleChunk(c0, lines0),
      simpleChunk(c1, lines1),
    ]);

    const outputLines = content.split('\n');

    // 总行数 = N0 (chunk0) + N1_MAIN (chunk1 去掉 overlap)
    assert.equal(outputLines.length, N0 + N1_MAIN);

    // 最后一行应是 L529
    assert.equal(outputLines[outputLines.length - 1], `L${N0 + N1_MAIN - 1}`);

    // chunk 1 的首个保留行（annotated=N0）对应 original=500
    const firstKeptPair = globalPairs.find(([ann]) => ann === N0);
    assert.ok(firstKeptPair, '应有 annotated=500 的 globalPair');
    assert.equal(firstKeptPair![1], N0, '应对应 originalLine=500');
  });

  test('overlap 边界精确：第 N-1 块末行保留，第 N 块 overlap 起点丢弃', () => {
    // chunk 0 末行 = C（original 2）
    // chunk 1 contextStart=2 → overlap 从 C 开始，C 不应出现两次
    const c0 = makeChunk(0, 0, 2, 0);
    const c1 = makeChunk(1, 3, 5, 2); // overlapLineCount=1

    const { content } = assembleChunks([
      simpleChunk(c0, ['A', 'B', 'C']),
      simpleChunk(c1, ['C', 'D', 'E']), // C 是 overlap，应被丢弃
    ]);

    const lines = content.split('\n');
    // C 只应出现一次（来自 chunk 0）
    assert.equal(lines.filter((l) => l === 'C').length, 1);
    assert.deepEqual(lines, ['A', 'B', 'C', 'D', 'E']);
  });

  test('注释行偏移 → globalPairs 正确平移', () => {
    // chunk 0: 2 行原文，行 1 有 1 行注释前缀
    // content: "A\n// comment\nB"
    // pairs: [[0,0],[2,1]] （A 在注释行 0，B 在注释行 2）
    const c0 = makeChunk(0, 0, 1, 0);
    const annotatedC0: AnnotatedChunk = {
      content: 'A\n// comment\nB',
      pairs: [[0, 0], [2, 1]],
      chunk: c0,
    };

    // chunk 1: 2 行（1 overlap + 1 main），无注释
    // contextStart=1, startLine=2, endLine=2
    const c1 = makeChunk(1, 2, 2, 1); // overlapLineCount=1
    const annotatedC1: AnnotatedChunk = {
      content: 'B\nC',
      pairs: [[0, 0], [1, 1]], // B=chunkLine0=0(overlap), C=chunkLine0=1(main)
      chunk: c1,
    };

    const { content, globalPairs } = assembleChunks([annotatedC0, annotatedC1]);

    // chunk 0 output: "A\n// comment\nB" → 3 lines
    // chunk 1 kept: slice from first pair where local>=1 → localAnn=1, kept=["C"]
    // globalOffset = 3
    // global pair for C: (1-1+3, contextStart(1)+1) = (3, 2)
    assert.equal(content, 'A\n// comment\nB\nC');
    assert.deepEqual(globalPairs, [
      [0, 0], // A → orig 0
      [2, 1], // B → orig 1
      [3, 2], // C → orig 2
    ]);
  });

  test('三块串联 globalPairs 无断层', () => {
    // 9 行文件（0-8），每块 1 行 overlap
    // chunk 0: lines 0-2 (3 行，无 overlap)
    // chunk 1: lines 2-5 (4 行：1 overlap + 3 main = lines 2,3,4,5)
    // chunk 2: lines 5-8 (4 行：1 overlap + 3 main = lines 5,6,7,8)
    const c0 = makeChunk(0, 0, 2, 0);
    const c1 = makeChunk(1, 3, 5, 2); // contextStart=2, overlapLineCount=1
    const c2 = makeChunk(2, 6, 8, 5); // contextStart=5, overlapLineCount=1

    const { globalPairs } = assembleChunks([
      simpleChunk(c0, ['A', 'B', 'C']),
      simpleChunk(c1, ['C', 'D', 'E', 'F']), // 4 行：C(overlap), D, E, F
      simpleChunk(c2, ['F', 'G', 'H', 'I']), // 4 行：F(overlap), G, H, I
    ]);

    // 每个 original line（0-8）都应有恰好 1 个 globalPair
    const origLines = globalPairs.map(([, o]) => o).sort((a, b) => a - b);
    assert.deepEqual(origLines, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
