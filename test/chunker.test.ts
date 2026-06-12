import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitBySemanticBoundary, OVERLAP_LINES, MAX_CHUNK_SIZE, Chunk } from '../src/chunker';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeLines(n: number, content = 'x'): string[] {
  return Array.from({ length: n }, (_, i) => `${content}${i}`);
}

function semanticLine(kind: 'ts-fn' | 'ts-class' | 'ts-export' | 'go-fn' | 'py-def' | 'rs-fn'): string {
  const map: Record<string, string> = {
    'ts-fn': 'function doSomething() {',
    'ts-class': 'class MyComponent {',
    'ts-export': 'export const handler = async () => {',
    'go-fn': 'func processRequest(ctx context.Context) error {',
    'py-def': 'def calculate_total(items):',
    'rs-fn': 'pub async fn handle_connection(stream: TcpStream) {',
  };
  return map[kind];
}

function assertSingleChunk(chunks: Chunk[], totalLines: number): void {
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].index, 0);
  assert.equal(chunks[0].startLine, 0);
  assert.equal(chunks[0].endLine, totalLines - 1);
  assert.equal(chunks[0].contextStart, 0);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('splitBySemanticBoundary', () => {
  test('空文件 → 返回空数组', () => {
    const chunks = splitBySemanticBoundary([]);
    assert.deepEqual(chunks, []);
  });

  test('单行文件 → 1 块，全部字段正确', () => {
    const chunks = splitBySemanticBoundary(['hello']);
    assertSingleChunk(chunks, 1);
  });

  test('≤ MAX_CHUNK_SIZE 行 → 1 块', () => {
    const lines = makeLines(MAX_CHUNK_SIZE);
    const chunks = splitBySemanticBoundary(lines);
    assertSingleChunk(chunks, MAX_CHUNK_SIZE);
  });

  test('blocks index 字段连续从 0 开始', () => {
    const lines = makeLines(MAX_CHUNK_SIZE + 10);
    const chunks = splitBySemanticBoundary(lines);
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(chunks[i].index, i);
    }
  });

  test('相邻块 endLine + 1 = 下一块 startLine（无行重叠）', () => {
    const lines = makeLines(MAX_CHUNK_SIZE * 3);
    const chunks = splitBySemanticBoundary(lines);
    for (let i = 0; i < chunks.length - 1; i++) {
      assert.equal(chunks[i].endLine + 1, chunks[i + 1].startLine);
    }
  });

  test('所有块覆盖 0..lines.length-1（无缺漏）', () => {
    const n = MAX_CHUNK_SIZE * 2 + 137;
    const lines = makeLines(n);
    const chunks = splitBySemanticBoundary(lines);
    assert.equal(chunks[0].startLine, 0);
    assert.equal(chunks[chunks.length - 1].endLine, n - 1);
  });

  test('任何块大小不超过 MAX_CHUNK_SIZE', () => {
    const lines = makeLines(MAX_CHUNK_SIZE * 4);
    const chunks = splitBySemanticBoundary(lines);
    for (const c of chunks) {
      const size = c.endLine - c.startLine + 1;
      assert.ok(size <= MAX_CHUNK_SIZE, `块 ${c.index} 大小 ${size} 超过 ${MAX_CHUNK_SIZE}`);
    }
  });

  test('overlap: contextStart = max(0, startLine - OVERLAP_LINES)', () => {
    const lines = makeLines(MAX_CHUNK_SIZE * 2);
    const chunks = splitBySemanticBoundary(lines);
    for (const c of chunks) {
      const expected = Math.max(0, c.startLine - OVERLAP_LINES);
      assert.equal(c.contextStart, expected, `块 ${c.index} contextStart 不正确`);
    }
  });

  test('第一块 contextStart = 0（没有前置上下文）', () => {
    const lines = makeLines(MAX_CHUNK_SIZE + 10);
    const chunks = splitBySemanticBoundary(lines);
    assert.equal(chunks[0].contextStart, 0);
  });

  test('TypeScript function 语义边界被识别', () => {
    const lines: string[] = [
      ...makeLines(300),
      semanticLine('ts-fn'),
      ...makeLines(300),
    ];
    const chunks = splitBySemanticBoundary(lines);
    // 301 处应该是块边界（语义切点在行 300 附近）
    assert.ok(chunks.length >= 2, '应有 ≥2 块');
    // 语义边界行 (300) 应成为某块的 startLine
    const hasSemanticBoundary = chunks.some((c) => c.startLine === 300);
    assert.ok(hasSemanticBoundary, '第 300 行（TypeScript function）应成为块起点');
  });

  test('多种语言语义边界均被识别', () => {
    const kinds: Array<'ts-fn' | 'ts-class' | 'ts-export' | 'go-fn' | 'py-def' | 'rs-fn'> = [
      'ts-fn', 'ts-class', 'ts-export', 'go-fn', 'py-def', 'rs-fn',
    ];
    for (const kind of kinds) {
      const lines: string[] = [...makeLines(300), semanticLine(kind), ...makeLines(300)];
      const chunks = splitBySemanticBoundary(lines);
      assert.ok(chunks.length >= 2, `${kind} 语义边界未被识别`);
    }
  });

  test('超大块 fallback 均等切分', () => {
    // 1200 行无任何语义边界 → 应被均等切分为 ≤500 行的块
    const lines = makeLines(1200);
    const chunks = splitBySemanticBoundary(lines);
    assert.ok(chunks.length >= 3, '1200 行无语义边界应至少 3 块');
    for (const c of chunks) {
      const size = c.endLine - c.startLine + 1;
      assert.ok(size <= MAX_CHUNK_SIZE, `均等切分后块大小 ${size} 超限`);
    }
  });

  test('overlap 上下文不超出文件头（startLine < OVERLAP_LINES 时 contextStart=0）', () => {
    const lines = makeLines(MAX_CHUNK_SIZE + 10);
    const chunks = splitBySemanticBoundary(lines);
    // 第一块 startLine=0，contextStart 必须是 0 而非负数
    assert.equal(chunks[0].contextStart, 0);
    // 第二块 startLine 可能 < OVERLAP_LINES，contextStart 应 = max(0, startLine - 30)
    if (chunks.length > 1) {
      const c = chunks[1];
      assert.equal(c.contextStart, Math.max(0, c.startLine - OVERLAP_LINES));
    }
  });
});
