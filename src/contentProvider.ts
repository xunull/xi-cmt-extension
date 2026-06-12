import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { streamAnnotate, streamAnnotateChunk, LlmError, LlmSettings, PromptPreset } from './llm';
import { PROMPT_VERSION, buildSystemPrompt } from './prompt';
import { parse, validate, renderWithLinemap, ConsistencyError, splitSourceLines } from './parser';
import {
  computeCacheKey,
  computeChunkCacheKey,
  computePromptHash,
  extractUriMeta,
  readCache,
  resolveCachePath,
  resolveLinemapPath,
  writeCacheAtomic,
} from './cache';
import {
  Linemap,
  LinemapSidecar,
  buildLinemapSidecar,
  readLinemapSidecar,
  writeLinemapSidecar,
} from './linemap';
import { splitBySemanticBoundary } from './chunker';
import { assembleChunks, AnnotatedChunk } from './assemble';
import { Semaphore } from './semaphore';

export const CMT_SCHEME = 'xi-cmt';

/**
 * URI 规范（design doc 锁定）：
 *   xi-cmt:/<workspace-relative-path-or-absolute>?hash=<sha>&model=<id>&pv=<promptVersion>
 */
export function buildCmtUri(originalUri: vscode.Uri, content: string, model: string): vscode.Uri {
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  const ws = vscode.workspace.getWorkspaceFolder(originalUri);
  const rel = ws ? path.relative(ws.uri.fsPath, originalUri.fsPath) : originalUri.fsPath;

  return vscode.Uri.from({
    scheme: CMT_SCHEME,
    path: '/' + addCmtSuffix(rel),
    query: `hash=${hash}&model=${encodeURIComponent(model)}&pv=${PROMPT_VERSION}`,
  });
}

function addCmtSuffix(rel: string): string {
  const ext = path.extname(rel);
  if (!ext) return rel + '.cmt';
  const base = rel.slice(0, -ext.length);
  return `${base}.cmt${ext}`;
}

interface StreamState {
  source: string;
  cachePath: string;
  linemapPath: string;
  originalUri: vscode.Uri;
  promptHash: string;
  /** 单块模式：LLM 原始流缓冲。多块模式：unused（用 totalChunks 区分） */
  buffer: string;
  done: boolean;
  error?: unknown;
  renderedFinal?: string;
  lastFire: number;
  /** 多块模式下有值 */
  totalChunks?: number;
  completedChunks?: number;
}

const FIRE_THROTTLE_MS = 200;
const MAX_CONCURRENT_LLM = 2;

export interface ErrorEvent {
  uri: vscode.Uri;
  error: unknown;
}

export interface StatusEvent {
  completedChunks: number;
  totalChunks: number;
  done: boolean;
}

export class CmtContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  private readonly _onError = new vscode.EventEmitter<ErrorEvent>();
  readonly onError = this._onError.event;

  private readonly _onStatus = new vscode.EventEmitter<StatusEvent>();
  readonly onStatus = this._onStatus.event;

  private readonly streams = new Map<string, StreamState>();
  private readonly semaphore = new Semaphore(MAX_CONCURRENT_LLM);

  /** 原始文件 URI → CMT URI（字符串），供 scroll sync 双向查找 */
  private readonly _originalToCmt = new Map<string, string>();
  private readonly _cmtToOriginal = new Map<string, string>();

  private readonly _linemaps = new Map<string, Linemap>();
  private readonly _linemapCallbacks = new Map<string, Array<(lm: Linemap) => void>>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  invalidate(uri: vscode.Uri): void {
    this.streams.delete(uri.toString());
    this._onDidChange.fire(uri);
  }

  invalidateAll(): void {
    const uris = Array.from(this.streams.keys()).map((k) => vscode.Uri.parse(k));
    this.streams.clear();
    for (const u of uris) this._onDidChange.fire(u);
  }

  getLinemap(cmtUri: vscode.Uri): Linemap | undefined {
    return this._linemaps.get(cmtUri.toString());
  }

  getCmtUriStringForOriginal(originalUri: vscode.Uri): string | undefined {
    return this._originalToCmt.get(originalUri.toString());
  }

  getOriginalUriStringForCmt(cmtUri: vscode.Uri): string | undefined {
    return this._cmtToOriginal.get(cmtUri.toString());
  }

  /** 注册一次性回调，在 linemap 就绪时触发（缓存命中时也会触发） */
  onLinemapReadyOnce(cmtUri: vscode.Uri, cb: (lm: Linemap) => void): void {
    const key = cmtUri.toString();
    const existing = this._linemapCallbacks.get(key) ?? [];
    existing.push(cb);
    this._linemapCallbacks.set(key, existing);
  }

  private setLinemap(cmtUri: vscode.Uri, linemap: Linemap): void {
    const key = cmtUri.toString();
    this._linemaps.set(key, linemap);
    const cbs = this._linemapCallbacks.get(key) ?? [];
    this._linemapCallbacks.delete(key);
    for (const cb of cbs) cb(linemap);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    let state = this.streams.get(key);

    if (!state) {
      const startResult = await this.startStream(uri);
      if (typeof startResult === 'string') return startResult;
      state = startResult;
    }

    if (state.done) {
      if (state.error !== undefined) return renderError(state.error, state.source);
      return state.renderedFinal ?? state.source;
    }
    if (state.totalChunks !== undefined) {
      return renderChunking(state.completedChunks ?? 0, state.totalChunks);
    }
    return renderInProgress(state.buffer, state.source);
  }

  private async startStream(uri: vscode.Uri): Promise<StreamState | string> {
    const originalUri = recoverOriginalUri(uri);
    if (!originalUri) {
      return `// xi-cmt: 无法从 ${uri.toString()} 反推原文件路径。`;
    }

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(originalUri);
    } catch (err) {
      return `// xi-cmt: 读取原文件失败：${err instanceof Error ? err.message : String(err)}`;
    }

    const source = doc.getText();
    const cfg = vscode.workspace.getConfiguration('xi-cmt');
    const model = cfg.get<string>('model', 'deepseek-chat');
    const promptPreset = (cfg.get<string>('promptPreset', 'expert') || 'expert') as PromptPreset;
    const customPrompt = cfg.get<string>('customPrompt', '') ?? '';
    const commentLanguage = cfg.get<string>('commentLanguage', 'zh-CN');

    // 用实际生效的 system prompt 内容算 hash，切换预设自动产生不同 cache key
    const effectiveSystemPrompt = buildSystemPrompt({
      languageId: doc.languageId,
      commentLanguage,
      promptPreset,
      customPrompt,
    });
    const promptHash = computePromptHash(effectiveSystemPrompt);

    const meta = extractUriMeta(uri);
    const cacheKey = computeCacheKey(meta.hash ?? 'nohash', meta.model ?? model, meta.pv ?? PROMPT_VERSION, promptHash);
    const cachePath = resolveCachePath(cacheKey);
    const linemapPath = resolveLinemapPath(cachePath);

    // 注册双向映射，供 extension.ts scroll sync 使用
    this._originalToCmt.set(originalUri.toString(), uri.toString());
    this._cmtToOriginal.set(uri.toString(), originalUri.toString());

    // 检查整文件缓存（最快路径）
    const cached = await readCache(cachePath);
    if (cached !== undefined) {
      const state: StreamState = {
        source, cachePath, linemapPath, originalUri, promptHash,
        buffer: cached, done: true, renderedFinal: cached, lastFire: 0,
      };
      this.streams.set(uri.toString(), state);
      // 加载 linemap sidecar（后台，不阻塞返回）
      readLinemapSidecar(linemapPath).then((sidecar) => {
        if (sidecar) this.setLinemap(uri, new Linemap(sidecar));
      }).catch(() => undefined);
      return state;
    }

    const apiKey = await this.context.secrets.get('xi-cmt.apiKey');
    const settings: LlmSettings = {
      baseURL: cfg.get<string>('baseURL', 'https://api.deepseek.com/v1'),
      model,
      apiKey,
      timeoutMs: cfg.get<number>('requestTimeoutMs', 120000),
      languageId: doc.languageId,
      commentLanguage,
      promptPreset,
      customPrompt,
    };

    const lines = splitSourceLines(source);
    const chunks = splitBySemanticBoundary(lines);
    const isChunked = chunks.length > 1;

    const state: StreamState = {
      source, cachePath, linemapPath, originalUri, promptHash,
      buffer: '', done: false, lastFire: 0,
      totalChunks: isChunked ? chunks.length : undefined,
      completedChunks: isChunked ? 0 : undefined,
    };
    this.streams.set(uri.toString(), state);

    if (isChunked) {
      void this.runChunks(uri, settings, state, lines, chunks);
    } else {
      void this.runStream(uri, settings, state);
    }

    return state;
  }

  /** 单块流式处理（原始路径，小文件 ≤ 500 行） */
  private async runStream(uri: vscode.Uri, settings: LlmSettings, state: StreamState): Promise<void> {
    try {
      await this.semaphore.run(async () => {
        for await (const chunk of streamAnnotate(state.source, settings)) {
          state.buffer += chunk;
          if (chunk.includes('\n')) {
            const now = Date.now();
            if (now - state.lastFire >= FIRE_THROTTLE_MS) {
              state.lastFire = now;
              this._onDidChange.fire(uri);
            }
          }
        }
      });

      const { parsed, trailingComments } = parse(state.buffer);
      validate(parsed, state.source);
      const { content, pairs } = renderWithLinemap(parsed, state.source, trailingComments);
      state.renderedFinal = content;
      state.done = true;

      try {
        await writeCacheAtomic(state.cachePath, content);
      } catch (err) {
        console.error('xi-cmt: writeCacheAtomic failed', err);
      }

      const lines = splitSourceLines(state.source);
      const sidecar = buildLinemapSidecar(pairs, content.split('\n').length, lines.length, true);
      this.setLinemap(uri, new Linemap(sidecar));
      writeLinemapSidecar(state.linemapPath, sidecar).catch((err) => {
        console.error('xi-cmt: writeLinemapSidecar failed', err);
      });

    } catch (err) {
      state.error = err;
      state.done = true;
      this._onError.fire({ uri, error: err });
    }
    this._onDidChange.fire(uri);
  }

  /** 多块并发处理（大文件 > 500 行） */
  private async runChunks(
    uri: vscode.Uri,
    settings: LlmSettings,
    state: StreamState,
    lines: string[],
    chunks: ReturnType<typeof splitBySemanticBoundary>
  ): Promise<void> {
    const annotatedChunks: AnnotatedChunk[] = [];

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkContent = lines.slice(chunk.contextStart, chunk.endLine + 1).join('\n');

        const chunkCacheKey = computeChunkCacheKey(
          chunkContent, chunk.index, settings.model, PROMPT_VERSION, state.promptHash
        );
        const chunkCachePath = resolveCachePath(chunkCacheKey);

        let chunkRendered: string;
        let chunkPairs: [number, number][];

        const cachedChunk = await readCache(chunkCachePath);
        if (cachedChunk !== undefined) {
          const { parsed, trailingComments } = parse(cachedChunk);
          const result = renderWithLinemap(parsed, chunkContent, trailingComments);
          chunkRendered = result.content;
          chunkPairs = result.pairs;
        } else {
          let buffer = '';
          await this.semaphore.run(async () => {
            for await (const delta of streamAnnotateChunk(
              chunkContent,
              { index: chunk.index, total: chunks.length },
              settings
            )) {
              buffer += delta;
              if (delta.includes('\n')) {
                const now = Date.now();
                if (now - state.lastFire >= FIRE_THROTTLE_MS) {
                  state.lastFire = now;
                  this._onDidChange.fire(uri);
                }
              }
            }
          });

          const { parsed, trailingComments } = parse(buffer);
          validate(parsed, chunkContent);
          const result = renderWithLinemap(parsed, chunkContent, trailingComments);
          chunkRendered = result.content;
          chunkPairs = result.pairs;

          writeCacheAtomic(chunkCachePath, chunkRendered).catch((err) => {
            console.error('xi-cmt: chunk writeCacheAtomic failed', err);
          });
        }

        annotatedChunks.push({ content: chunkRendered, pairs: chunkPairs, chunk });
        state.completedChunks = i + 1;

        this._onStatus.fire({
          completedChunks: i + 1,
          totalChunks: chunks.length,
          done: false,
        });
        this._onDidChange.fire(uri);
      }

      // 全部块完成：拼装 + 写缓存 + 写 linemap
      const { content: assembled, globalPairs } = assembleChunks(annotatedChunks);
      state.renderedFinal = assembled;
      state.done = true;

      writeCacheAtomic(state.cachePath, assembled).catch((err) => {
        console.error('xi-cmt: whole-file writeCacheAtomic failed', err);
      });

      const sidecar = buildLinemapSidecar(
        globalPairs,
        assembled.split('\n').length,
        lines.length,
        true
      );
      this.setLinemap(uri, new Linemap(sidecar));
      writeLinemapSidecar(state.linemapPath, sidecar).catch((err) => {
        console.error('xi-cmt: writeLinemapSidecar failed', err);
      });

      this._onStatus.fire({ completedChunks: chunks.length, totalChunks: chunks.length, done: true });

    } catch (err) {
      state.error = err;
      state.done = true;
      this._onError.fire({ uri, error: err });
    }
    this._onDidChange.fire(uri);
  }
}

function renderInProgress(buffer: string, source: string): string {
  const { parsed, trailingComments } = parse(buffer);
  const renderedSoFar = renderWithLinemap(parsed, source, trailingComments).content;
  const annotatedCount = parsed.filter((p) => p.leadingComments.length > 0).length;
  const footer = `\n\n// ⏳ xi-cmt: 流式生成中... 已收到 ${annotatedCount} 条注释段，${parsed.length} 个锚点`;
  return renderedSoFar + footer;
}

function renderChunking(completedChunks: number, totalChunks: number): string {
  return [
    '// ════════════════════════════════════════════════════════════════',
    `// 📖 xi-cmt: 大文件分块生成中... [${completedChunks}/${totalChunks} 块已完成]`,
    `// 完成后自动显示完整注释视图。`,
    '// ════════════════════════════════════════════════════════════════',
  ].join('\n');
}

function renderError(err: unknown, source: string): string {
  const header: string[] = [
    '// ════════════════════════════════════════════════════════════════',
    '// xi-cmt: 注释生成失败',
  ];
  if (err instanceof LlmError) {
    header.push(`// 错误类型: LLM ${err.kind}` + (err.status ? ` (HTTP ${err.status})` : ''));
    header.push(`// 详情: ${err.message}`);
    if (err.kind === 'invalid_config' || err.kind === 'auth') {
      header.push(`// 修复: 运行命令 "xi-cmt: Set API Key" 配置 API Key`);
    } else if (err.kind === 'model_not_found') {
      header.push(`// 修复: 检查 settings 里 xi-cmt.model 与 xi-cmt.baseURL 是否匹配`);
    } else if (err.kind === 'quota') {
      header.push(`// 修复: 检查 API 账户余额或切换 model`);
    } else if (err.kind === 'timeout') {
      header.push(`// 修复: 在 settings 里把 xi-cmt.requestTimeoutMs 调高`);
    }
  } else if (err instanceof ConsistencyError) {
    header.push(`// 错误类型: LLM 输出软校验失败`);
    header.push(`// 详情: ${err.message}`);
    header.push(`// 命中: ${err.anchorsHit}/${err.anchorsExpected}, mismatch: ${err.mismatches}`);
    header.push(`// 修复: 重新执行命令重试一次；如反复失败，切换 model（推荐 deepseek-chat / kimi-k2 / qwen2.5-coder）`);
  } else {
    header.push(`// 详情: ${err instanceof Error ? err.message : String(err)}`);
  }
  header.push('// 下方是原文（未注释）：');
  header.push('// ════════════════════════════════════════════════════════════════');
  return header.join('\n') + '\n\n' + source;
}

/**
 * 从 CMT URI 反推原始文件 URI。
 * Arch-3 修复：原代码在 for 循环内直接 return，永远只取第一个 workspace folder。
 * 修复后：绝对路径直接还原；相对路径尝试各 workspace folder，找到不越界的候选路径。
 */
function recoverOriginalUri(cmtUri: vscode.Uri): vscode.Uri | undefined {
  const cmtPath = cmtUri.path.startsWith('/') ? cmtUri.path.slice(1) : cmtUri.path;
  const original = stripCmtSuffix(cmtPath);

  if (path.isAbsolute(original)) {
    return vscode.Uri.file(original);
  }

  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    for (const f of folders) {
      const candidate = vscode.Uri.joinPath(f.uri, original);
      const rel = path.relative(f.uri.fsPath, candidate.fsPath);
      if (!rel.startsWith('..')) return candidate;
    }
    return vscode.Uri.joinPath(folders[0].uri, original);
  }

  return vscode.Uri.file('/' + original);
}

function stripCmtSuffix(p: string): string {
  const ext = path.extname(p);
  if (!ext) {
    return p.endsWith('.cmt') ? p.slice(0, -4) : p;
  }
  const base = p.slice(0, -ext.length);
  if (base.endsWith('.cmt')) {
    return base.slice(0, -4) + ext;
  }
  return p;
}
