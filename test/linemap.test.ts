import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Linemap,
  buildLinemapSidecar,
  readLinemapSidecar,
  writeLinemapSidecar,
  LinemapSidecar,
} from '../src/linemap';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeSidecar(pairs: [number, number][], isComplete = true): LinemapSidecar {
  return buildLinemapSidecar(pairs, pairs.length, pairs.length, isComplete);
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'xi-cmt-test-'));
  try {
    await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

// ─── Linemap class ────────────────────────────────────────────────────────────

describe('Linemap', () => {
  test('getAnnotated: 原始行 → 注释行', () => {
    const lm = new Linemap(makeSidecar([[0, 0], [3, 1], [5, 2]]));
    assert.equal(lm.getAnnotated(0), 0);
    assert.equal(lm.getAnnotated(1), 3);
    assert.equal(lm.getAnnotated(2), 5);
  });

  test('getOriginal: 注释行 → 原始行', () => {
    const lm = new Linemap(makeSidecar([[0, 0], [3, 1], [5, 2]]));
    assert.equal(lm.getOriginal(0), 0);
    assert.equal(lm.getOriginal(3), 1);
    assert.equal(lm.getOriginal(5), 2);
  });

  test('无映射时返回 undefined', () => {
    const lm = new Linemap(makeSidecar([[0, 0], [1, 1]]));
    assert.equal(lm.getAnnotated(99), undefined);
    assert.equal(lm.getOriginal(99), undefined);
  });

  test('重复 originalLine 以第一次出现为准', () => {
    // originalLine 1 映射到 annotated 2，后面的 [5,1] 应被忽略
    const lm = new Linemap(makeSidecar([[2, 1], [5, 1]]));
    assert.equal(lm.getAnnotated(1), 2);
  });

  test('重复 annotatedLine 以第一次出现为准', () => {
    // annotated 2 映射到 original 1，后面的 [2,3] 应被忽略
    const lm = new Linemap(makeSidecar([[2, 1], [2, 3]]));
    assert.equal(lm.getOriginal(2), 1);
  });

  test('isComplete 字段正确传递', () => {
    const lm = new Linemap(makeSidecar([[0, 0]], false));
    assert.equal(lm.isComplete, false);
  });

  test('totalAnnotatedLines / totalOriginalLines 字段正确', () => {
    const sidecar = buildLinemapSidecar([[0, 0], [2, 1]], 10, 5, true);
    const lm = new Linemap(sidecar);
    assert.equal(lm.totalAnnotatedLines, 10);
    assert.equal(lm.totalOriginalLines, 5);
  });

  test('大文件 1000 行双向查找正确', () => {
    const pairs: [number, number][] = Array.from({ length: 1000 }, (_, i) => [i + Math.floor(i / 10), i]);
    const lm = new Linemap(makeSidecar(pairs));
    // 验证双向一致性
    for (let orig = 0; orig < 1000; orig++) {
      const ann = lm.getAnnotated(orig)!;
      assert.equal(lm.getOriginal(ann), orig);
    }
  });
});

// ─── buildLinemapSidecar ─────────────────────────────────────────────────────

describe('buildLinemapSidecar', () => {
  test('version 字段固定为 "1"', () => {
    const s = buildLinemapSidecar([[0, 0]], 1, 1, true);
    assert.equal(s.version, '1');
  });

  test('所有字段原样保留', () => {
    const pairs: [number, number][] = [[0, 0], [5, 1], [8, 2]];
    const s = buildLinemapSidecar(pairs, 100, 50, false);
    assert.deepEqual(s.pairs, pairs);
    assert.equal(s.totalAnnotatedLines, 100);
    assert.equal(s.totalOriginalLines, 50);
    assert.equal(s.isComplete, false);
  });
});

// ─── readLinemapSidecar / writeLinemapSidecar ─────────────────────────────────

describe('readLinemapSidecar / writeLinemapSidecar', () => {
  test('写入后读取：数据完整还原', async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, 'test.linemap.json');
      const pairs: [number, number][] = [[0, 0], [3, 1], [7, 2]];
      const sidecar = buildLinemapSidecar(pairs, 10, 3, true);

      await writeLinemapSidecar(p, sidecar);
      const read = await readLinemapSidecar(p);

      assert.ok(read, '应成功读取');
      assert.equal(read!.version, '1');
      assert.deepEqual(read!.pairs, pairs);
      assert.equal(read!.totalAnnotatedLines, 10);
      assert.equal(read!.totalOriginalLines, 3);
      assert.equal(read!.isComplete, true);
    });
  });

  test('文件不存在 → 返回 undefined', async () => {
    const result = await readLinemapSidecar('/nonexistent/path/file.linemap.json');
    assert.equal(result, undefined);
  });

  test('JSON 格式错误 → 返回 undefined', async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, 'bad.linemap.json');
      await fs.promises.writeFile(p, 'not valid json', 'utf8');
      const result = await readLinemapSidecar(p);
      assert.equal(result, undefined);
    });
  });

  test('version 不是 "1" → 返回 undefined', async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, 'v2.linemap.json');
      await fs.promises.writeFile(p, JSON.stringify({ version: '2', pairs: [] }), 'utf8');
      const result = await readLinemapSidecar(p);
      assert.equal(result, undefined);
    });
  });

  test('pairs 不是数组 → 返回 undefined', async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, 'bad-pairs.linemap.json');
      await fs.promises.writeFile(p, JSON.stringify({ version: '1', pairs: 'not an array' }), 'utf8');
      const result = await readLinemapSidecar(p);
      assert.equal(result, undefined);
    });
  });

  test('写入目录不存在时自动创建', async () => {
    await withTempDir(async (dir) => {
      const nested = path.join(dir, 'a', 'b', 'c', 'test.linemap.json');
      const sidecar = buildLinemapSidecar([[0, 0]], 1, 1, true);
      await writeLinemapSidecar(nested, sidecar);
      const read = await readLinemapSidecar(nested);
      assert.ok(read);
    });
  });

  test('原子写：tmp 文件不遗留', async () => {
    await withTempDir(async (dir) => {
      const p = path.join(dir, 'atomic.linemap.json');
      await writeLinemapSidecar(p, buildLinemapSidecar([[0, 0]], 1, 1, true));
      const entries = await fs.promises.readdir(dir);
      // 只应有一个文件（.linemap.json），不应有 .tmp.* 残留
      assert.equal(entries.length, 1);
      assert.ok(entries[0].endsWith('.linemap.json'));
    });
  });
});
