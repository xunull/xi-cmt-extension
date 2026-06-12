/**
 * 注释视图与原始文件的行号映射（Linemap）。
 *
 * 用途：
 *   1. 打开注释视图时对齐到原始编辑器的当前视口
 *   2. 双向同步滚动（extension.ts onDidChangeTextEditorVisibleRanges）
 *
 * 坐标系：全部 0-based，与 VS Code TextEditor API 一致。
 * 存储格式：sidecar JSON（.linemap.json）与 .cmt 缓存同目录。
 */

import * as fs from 'fs';
import * as path from 'path';

/** sidecar 文件的 JSON 结构 */
export interface LinemapSidecar {
  version: '1';
  /** [annotatedLine0, originalLine0] 对，按 annotatedLine0 升序，均 0-based */
  pairs: [number, number][];
  totalAnnotatedLines: number;
  totalOriginalLines: number;
  /** false = 分块注释尚未全部完成（partial 状态下滚动同步降级为不可用） */
  isComplete: boolean;
}

/** 内存中的双向查找结构，从 LinemapSidecar 构建 */
export class Linemap {
  private readonly _originalToAnnotated: Map<number, number>;
  private readonly _annotatedToOriginal: Map<number, number>;
  readonly totalAnnotatedLines: number;
  readonly totalOriginalLines: number;
  readonly isComplete: boolean;

  constructor(sidecar: LinemapSidecar) {
    this._originalToAnnotated = new Map();
    this._annotatedToOriginal = new Map();
    for (const [ann, orig] of sidecar.pairs) {
      if (!this._originalToAnnotated.has(orig)) {
        this._originalToAnnotated.set(orig, ann);
      }
      if (!this._annotatedToOriginal.has(ann)) {
        this._annotatedToOriginal.set(ann, orig);
      }
    }
    this.totalAnnotatedLines = sidecar.totalAnnotatedLines;
    this.totalOriginalLines = sidecar.totalOriginalLines;
    this.isComplete = sidecar.isComplete;
  }

  /** 原始行（0-based） → 注释视图行（0-based）；无映射返回 undefined */
  getAnnotated(originalLine0: number): number | undefined {
    return this._originalToAnnotated.get(originalLine0);
  }

  /** 注释视图行（0-based） → 原始行（0-based）；无映射返回 undefined */
  getOriginal(annotatedLine0: number): number | undefined {
    return this._annotatedToOriginal.get(annotatedLine0);
  }
}

export function buildLinemapSidecar(
  pairs: [number, number][],
  totalAnnotatedLines: number,
  totalOriginalLines: number,
  isComplete: boolean
): LinemapSidecar {
  return { version: '1', pairs, totalAnnotatedLines, totalOriginalLines, isComplete };
}

/** 读取 sidecar；版本或格式不对返回 undefined */
export async function readLinemapSidecar(sidecarPath: string): Promise<LinemapSidecar | undefined> {
  try {
    const text = await fs.promises.readFile(sidecarPath, 'utf8');
    const data = JSON.parse(text) as LinemapSidecar;
    if (data.version !== '1' || !Array.isArray(data.pairs)) return undefined;
    return data;
  } catch {
    return undefined;
  }
}

/** 原子写（mktemp + rename），与 writeCacheAtomic 同逻辑 */
export async function writeLinemapSidecar(sidecarPath: string, data: LinemapSidecar): Promise<void> {
  await fs.promises.mkdir(path.dirname(sidecarPath), { recursive: true });
  const tmp = `${sidecarPath}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fs.promises.rename(tmp, sidecarPath);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

