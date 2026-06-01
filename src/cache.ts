/**
 * 文件级缓存：把 render 后的最终视图按 cacheKey 落盘。
 *
 * cacheKey 公式：`<contentHash>.<sanitizedModel>.<promptVersion>` —— 可读 + 跨平台安全。
 * 例如：a1b2c3d4.deepseek-chat.v0.1.0-step2.cmt
 *
 * 存储位置（由 settings.xi-cmt.cacheMode 控制）：
 *   - 'project'：<workspace-root>/.vscode/.cmt-cache/  （跟项目走，用户决定是否入 git）
 *   - 'user'：<homedir>/.cache/xi-cmt/                   （跨项目共享，不入任何 git）
 *
 * project 模式 fallback：当用户打开单文件而非 workspace folder 时，自动回退到 user 模式。
 *
 * 写文件用 mktemp + rename 原子写，保证读到的永远是完整内容（不会读到流式半成品）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export type CacheMode = 'project' | 'user';

export interface CachePathOpts {
  mode: CacheMode;
  /** 原文件 Uri，用于推断 workspace folder（project 模式需要） */
  originalUri: vscode.Uri;
}

/** 计算最终落盘的 cacheKey 文件名（不含扩展名）。 */
export function computeCacheKey(contentHash: string, model: string, promptVersion: string): string {
  const sanModel = model.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  return `${contentHash}.${sanModel}.${promptVersion}`;
}

/** 把 URI.query 里的 hash / model / pv 抽出来。design doc URI 规范的反操作。 */
export function extractUriMeta(cmtUri: vscode.Uri): { hash?: string; model?: string; pv?: string } {
  const params = new URLSearchParams(cmtUri.query);
  return {
    hash: params.get('hash') ?? undefined,
    model: params.get('model') ?? undefined,
    pv: params.get('pv') ?? undefined,
  };
}

export function resolveCacheDir(opts: CachePathOpts): string {
  if (opts.mode === 'project') {
    const ws = vscode.workspace.getWorkspaceFolder(opts.originalUri);
    if (ws) return path.join(ws.uri.fsPath, '.vscode', '.cmt-cache');
    // 单文件场景：fallback 到 user 模式
  }
  return path.join(os.homedir(), '.cache', 'xi-cmt');
}

export function resolveCachePath(cacheKey: string, opts: CachePathOpts): string {
  return path.join(resolveCacheDir(opts), `${cacheKey}.cmt`);
}

/** 命中返回内容；不存在 / 读取失败返回 undefined（视为未命中）。 */
export async function readCache(p: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(p, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return undefined;
    // 其它读取错误（权限 / EIO）：视为未命中，让上游重新生成
    return undefined;
  }
}

/**
 * 原子写：mktemp 同目录 + rename。
 * 同目录 mktemp 才能保证 rename 是原子操作（跨 fs 的 rename 会变成 copy+delete）。
 */
export async function writeCacheAtomic(p: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.promises.writeFile(tmp, content, 'utf8');
    await fs.promises.rename(tmp, p);
  } catch (err) {
    // 失败：清理 tmp 残留，再抛出
    await fs.promises.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export interface ClearResult {
  removed: number;
  scannedDirs: string[];
}

/**
 * 清理所有缓存。遍历每个 workspace 的 .vscode/.cmt-cache/ 和 user 目录 ~/.cache/xi-cmt/。
 * 删除 *.cmt 和遗留的 *.cmt.tmp.*。
 */
export async function clearAllCaches(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<ClearResult> {
  const dirs = new Set<string>();
  for (const ws of workspaceFolders) {
    dirs.add(path.join(ws.uri.fsPath, '.vscode', '.cmt-cache'));
  }
  dirs.add(path.join(os.homedir(), '.cache', 'xi-cmt'));

  let removed = 0;
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch (err) {
      if (!isNotFound(err)) {
        // 其它错误：跳过该目录，不影响其它
      }
      continue;
    }
    for (const e of entries) {
      if (e.endsWith('.cmt') || /\.cmt\.tmp\./.test(e)) {
        const full = path.join(dir, e);
        try {
          await fs.promises.unlink(full);
          removed++;
        } catch {
          // ignore
        }
      }
    }
  }
  return { removed, scannedDirs: Array.from(dirs) };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
