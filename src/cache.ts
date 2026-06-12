/**
 * 文件级缓存：把 render 后的最终视图按 cacheKey 落盘。
 *
 * cacheKey 公式：`<contentHash>.<sanitizedModel>.<promptVersion>` —— 可读 + 跨平台安全。
 * 例如：a1b2c3d4.deepseek-chat.v0.1.0-step2.cmt
 *
 * 存储位置：~/.cache/xi-cmt/（跨项目共享，不入任何 git）
 *
 * 写文件用 mktemp + rename 原子写，保证读到的永远是完整内容（不会读到流式半成品）。
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** 计算当前生效的 system prompt 的短哈希，用于区分不同预设 / 自定义 prompt 的缓存。 */
export function computePromptHash(systemPrompt: string): string {
  return crypto.createHash('sha256').update(systemPrompt).digest('hex').slice(0, 8);
}

/**
 * 分块缓存 key。key = sha256(chunkContent+chunkIndex) + model + promptVersion + promptHash + chunkN。
 * chunkContent 包含 overlap 上下文，确保上下文变化时 key 也变。
 * promptHash 确保切换预设后缓存自动失效。
 */
export function computeChunkCacheKey(
  chunkContent: string,
  chunkIndex: number,
  model: string,
  promptVersion: string,
  promptHash: string
): string {
  const hash = crypto
    .createHash('sha256')
    .update(chunkContent + chunkIndex.toString())
    .digest('hex')
    .slice(0, 16);
  const sanModel = model.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  return `${hash}.${sanModel}.${promptVersion}.${promptHash}.chunk${chunkIndex}`;
}

/** linemap sidecar 路径：把 .cmt 后缀替换为 .linemap.json，与缓存文件同目录 */
export function resolveLinemapPath(cachePath: string): string {
  return cachePath.endsWith('.cmt')
    ? cachePath.slice(0, -4) + '.linemap.json'
    : cachePath + '.linemap.json';
}

/** 计算最终落盘的 cacheKey 文件名（不含扩展名）。promptHash 区分不同预设的缓存。 */
export function computeCacheKey(
  contentHash: string,
  model: string,
  promptVersion: string,
  promptHash: string
): string {
  const sanModel = model.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
  return `${contentHash}.${sanModel}.${promptVersion}.${promptHash}`;
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

export function resolveCacheDir(): string {
  return path.join(os.homedir(), '.cache', 'xi-cmt');
}

export function resolveCachePath(cacheKey: string): string {
  return path.join(resolveCacheDir(), `${cacheKey}.cmt`);
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
 * 清理所有缓存。删除 ~/.cache/xi-cmt/ 下的 *.cmt、*.linemap.json 及遗留 tmp 文件。
 */
export async function clearAllCaches(): Promise<ClearResult> {
  const dirs = new Set<string>();
  dirs.add(resolveCacheDir());

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
      if (e.endsWith('.cmt') || e.endsWith('.linemap.json') || /\.cmt\.tmp\./.test(e) || /\.linemap\.json\.tmp\./.test(e)) {
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
