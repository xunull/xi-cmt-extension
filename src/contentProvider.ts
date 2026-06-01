import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { streamAnnotate, LlmError, LlmSettings } from './llm';
import { PROMPT_VERSION } from './prompt';
import { parse, validate, render, ConsistencyError } from './parser';
import {
  CacheMode,
  computeCacheKey,
  extractUriMeta,
  readCache,
  resolveCachePath,
  writeCacheAtomic,
} from './cache';
import { Semaphore } from './semaphore';

export const CMT_SCHEME = 'xi-cmt';

/**
 * URI 规范（design doc 锁定）：
 *   xi-cmt:/<workspace-relative-path-or-absolute>?hash=<sha>&model=<id>&pv=<promptVersion>
 *
 * model + promptVersion 进 URI → 换 model / bump prompt 产生新 cmtUri、新 cacheKey、新缓存条目。
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

/**
 * 一次预览的流式状态机。
 *
 * 生命周期：
 *   1. 首次 provideTextDocumentContent → startStream
 *      a. 算 cachePath，readCache → 命中 → state.done=true, renderedFinal=cached（秒开）
 *      b. 未命中 → 启动 runStream（semaphore 限流，过 2 并发会排队）
 *   2. runStream 收到 chunk → 累积 buffer + 节流 200ms fire onDidChange
 *      VS Code 重新 provide → 返回 buffer 的中间渲染
 *   3. runStream 流完 → parse + validate + render → renderedFinal → 原子写缓存
 *   4. 之后所有对该 cmtUri 的 provide 都命中内存（streams Map），不再触发 LLM
 *
 * 同 cmtUri 并发 provide：streams Map 一旦有 state，后续直接复用，不会启动第二次流。
 */
interface StreamState {
  source: string;
  cachePath: string;
  buffer: string;
  done: boolean;
  error?: unknown;
  renderedFinal?: string;
  lastFire: number;
}

const FIRE_THROTTLE_MS = 200;
const MAX_CONCURRENT_LLM = 2;

export interface ErrorEvent {
  uri: vscode.Uri;
  error: unknown;
}

export class CmtContentProvider implements vscode.TextDocumentContentProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  /** runStream catch 异常时 fire——让 extension 弹窗 + 提供按钮 */
  private readonly _onError = new vscode.EventEmitter<ErrorEvent>();
  readonly onError = this._onError.event;

  private readonly streams = new Map<string, StreamState>();
  private readonly semaphore = new Semaphore(MAX_CONCURRENT_LLM);

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** 主动失效某个 cmtUri 的内存状态，让下次 provide 重新走 cache 检查 → LLM */
  invalidate(uri: vscode.Uri): void {
    this.streams.delete(uri.toString());
    this._onDidChange.fire(uri);
  }

  /** 清掉所有内存状态（xi-cmt.clearCache 命令调用）。不删磁盘缓存——磁盘清理由 cache.clearAllCaches 负责。 */
  invalidateAll(): void {
    const uris = Array.from(this.streams.keys()).map((k) => vscode.Uri.parse(k));
    this.streams.clear();
    for (const u of uris) this._onDidChange.fire(u);
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
    return renderInProgress(state.buffer, state.source);
  }

  /**
   * 启动一次新流（或命中缓存直接返回）。
   * 返回 StreamState（成功，已记录到 streams Map）或 string（启动前错误）
   */
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

    const maxLines = cfg.get<number>('maxLines', 1500);
    const lineCount = source.split('\n').length;
    if (lineCount > maxLines) {
      return [
        `// xi-cmt: 文件行数 ${lineCount} 超过 maxLines=${maxLines}。`,
        `// 临时方案：把该文件局部代码复制到新文件后再 Open Annotated Preview。`,
        `// 或在 settings.json 把 xi-cmt.maxLines 调大（V1.x 加分块后才推荐 > 2000）。`,
      ].join('\n');
    }

    // 算缓存路径
    const meta = extractUriMeta(uri);
    const model = cfg.get<string>('model', 'deepseek-chat');
    const cacheMode = (cfg.get<string>('cacheMode', 'project') as CacheMode) ?? 'project';
    const cacheKey = computeCacheKey(meta.hash ?? 'nohash', meta.model ?? model, meta.pv ?? PROMPT_VERSION);
    const cachePath = resolveCachePath(cacheKey, { mode: cacheMode, originalUri });

    // 检查缓存
    const cached = await readCache(cachePath);
    if (cached !== undefined) {
      const state: StreamState = {
        source,
        cachePath,
        buffer: cached,
        done: true,
        renderedFinal: cached,
        lastFire: 0,
      };
      this.streams.set(uri.toString(), state);
      return state;
    }

    const apiKey = await this.context.secrets.get('xi-cmt.apiKey');
    const settings: LlmSettings = {
      baseURL: cfg.get<string>('baseURL', 'https://api.deepseek.com/v1'),
      model,
      apiKey,
      timeoutMs: cfg.get<number>('requestTimeoutMs', 120000),
      languageId: doc.languageId,
      commentLanguage: cfg.get<string>('commentLanguage', 'zh-CN'),
    };

    const state: StreamState = {
      source,
      cachePath,
      buffer: '',
      done: false,
      lastFire: 0,
    };
    this.streams.set(uri.toString(), state);

    void this.runStream(uri, settings, state);
    return state;
  }

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
      state.renderedFinal = render(parsed, state.source, trailingComments);
      state.done = true;
      // 写缓存：失败不阻塞显示
      try {
        await writeCacheAtomic(state.cachePath, state.renderedFinal);
      } catch (err) {
        console.error('xi-cmt: writeCacheAtomic failed', err);
      }
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
  const renderedSoFar = render(parsed, source, trailingComments);
  const annotatedCount = parsed.filter((p) => p.leadingComments.length > 0).length;
  const footer = `\n\n// ⏳ xi-cmt: 流式生成中... 已收到 ${annotatedCount} 条注释段，${parsed.length} 个锚点`;
  return renderedSoFar + footer;
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

function recoverOriginalUri(cmtUri: vscode.Uri): vscode.Uri | undefined {
  const cmtPath = cmtUri.path.startsWith('/') ? cmtUri.path.slice(1) : cmtUri.path;
  const original = stripCmtSuffix(cmtPath);

  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    for (const f of folders) {
      return vscode.Uri.joinPath(f.uri, original);
    }
  }
  return vscode.Uri.file(original.startsWith('/') ? original : '/' + original);
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
