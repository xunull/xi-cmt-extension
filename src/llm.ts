/**
 * OpenAI Chat Completions 兼容协议适配。
 *
 * 支持 OpenAI / DeepSeek / Moonshot / SiliconFlow / Ollama 等任何兼容 endpoint。
 * 只调最小子集（messages + stream + temperature）——不用 function calling / tools / response_format，
 * 兼容性责任推给用户配置（baseURL + model）。
 *
 * 提供两个出口：
 *   - streamAnnotate(): AsyncGenerator<string> —— Step 4 起 contentProvider 用此（边收边渲染）
 *   - annotate(): Promise<string> —— test-llm.ts / 一次性场景用此（内部走非流式 endpoint）
 *
 * Step 4 设计权衡：
 *   - 流式不 retry：已经发出去的 chunk 不能撤回，中途断流直接抛 network error
 *   - 非流式仍然 retry 一次（429/5xx + 1s backoff）
 */

import { buildSystemPrompt, buildUserPrompt, PromptOptions } from './prompt';

export interface LlmSettings extends PromptOptions {
  baseURL: string;
  model: string;
  /** undefined 表示用户没配置 API Key（Ollama 本地场景允许；远程 baseURL 时抛错） */
  apiKey: string | undefined;
  timeoutMs: number;
}

const LOCAL_HOST_RE = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i;

function isLocalEndpoint(baseURL: string): boolean {
  return LOCAL_HOST_RE.test(baseURL);
}

function buildEndpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/chat/completions`;
}

export class LlmError extends Error {
  readonly kind:
    | 'invalid_config'
    | 'auth'
    | 'model_not_found'
    | 'quota'
    | 'timeout'
    | 'network'
    | 'response_shape';
  readonly status?: number;
  constructor(kind: LlmError['kind'], message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
  }
}

interface ChatChoiceMessage {
  role?: string;
  content?: string;
}
interface ChatChoiceDelta {
  role?: string;
  content?: string;
}
interface ChatChoice {
  index?: number;
  message?: ChatChoiceMessage;
  delta?: ChatChoiceDelta;
  finish_reason?: string;
}
interface ChatCompletionResponse {
  choices?: ChatChoice[];
  error?: { message?: string; type?: string; code?: string };
}

interface RequestPlan {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

function preflight(settings: LlmSettings): void {
  if (!settings.apiKey && !isLocalEndpoint(settings.baseURL)) {
    throw new LlmError(
      'invalid_config',
      `远程 baseURL ${settings.baseURL} 需要 API Key。请运行命令: xi-cmt: Set API Key`
    );
  }
}

function buildRequest(source: string, settings: LlmSettings, stream: boolean): RequestPlan {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  if (stream) headers.Accept = 'text/event-stream';

  const body = JSON.stringify({
    model: settings.model,
    messages: [
      { role: 'system', content: buildSystemPrompt(settings) },
      { role: 'user', content: buildUserPrompt(source, settings) },
    ],
    stream,
    temperature: 0.2,
  });

  return { url: buildEndpoint(settings.baseURL), headers, body, timeoutMs: settings.timeoutMs };
}

/** 把 HTTP 非 2xx 状态码翻译成对应的 LlmError */
function classifyHttpError(status: number, statusText: string, bodyText: string): LlmError {
  const snippet = bodyText.slice(0, 200);
  if (status === 401 || status === 403) {
    return new LlmError('auth', `${status} 鉴权失败：${snippet || statusText}`, status);
  }
  if (status === 404) {
    return new LlmError(
      'model_not_found',
      `404 model 不存在或 endpoint 错误：${snippet || statusText}`,
      status
    );
  }
  if (status === 429) {
    return new LlmError('quota', `429 限流/额度不足：${snippet || statusText}`, status);
  }
  if (status >= 500 && status < 600) {
    return new LlmError('network', `${status} 服务端错误：${snippet || statusText}`, status);
  }
  return new LlmError('network', `${status} ${statusText}: ${snippet}`, status);
}

/**
 * 一次性返回完整注释（非流式，带重试）。test-llm.ts 与不需要流式渲染的场景用此。
 */
export async function annotate(source: string, settings: LlmSettings): Promise<string> {
  preflight(settings);
  const plan = buildRequest(source, settings, false);

  const MAX_ATTEMPTS = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), plan.timeoutMs);
    try {
      const res = await fetch(plan.url, {
        method: 'POST',
        headers: plan.headers,
        body: plan.body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const json = (await res.json()) as ChatCompletionResponse;
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.length === 0) {
          throw new LlmError(
            'response_shape',
            `LLM 响应缺少 choices[0].message.content。原始响应片段：${JSON.stringify(json).slice(0, 200)}`
          );
        }
        return content;
      }

      const text = await res.text().catch(() => '');
      const err = classifyHttpError(res.status, res.statusText, text);
      // 仅 quota(429) / 5xx network 在 attempt < MAX 时重试
      if ((err.kind === 'quota' || err.kind === 'network') && attempt < MAX_ATTEMPTS) {
        await sleep(1000);
        continue;
      }
      throw err;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err instanceof LlmError) throw err;
      if (isAbortError(err)) {
        throw new LlmError('timeout', `LLM 请求超时（${plan.timeoutMs}ms）`);
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1000);
        continue;
      }
      throw new LlmError(
        'network',
        `网络错误：${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  throw new LlmError(
    'network',
    `LLM 调用失败（重试用完）：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}

/**
 * 流式注释。逐块 yield LLM 返回的 delta.content 文本片段。
 *
 * SSE 解析逻辑：
 *   - 按 \n 切行
 *   - 只处理 `data: ` 开头的行
 *   - payload === '[DONE]' 视为流结束
 *   - 否则 JSON.parse 取 choices[0]?.delta?.content
 *
 * caller 可通过 AbortSignal 提前终止（VS Code 用户关闭文档时）。
 */
export async function* streamAnnotate(
  source: string,
  settings: LlmSettings,
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
  preflight(settings);
  const plan = buildRequest(source, settings, true);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), plan.timeoutMs);
  const onAbort = (): void => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort);
  }

  let res: Response;
  try {
    res = await fetch(plan.url, {
      method: 'POST',
      headers: plan.headers,
      body: plan.body,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (isAbortError(err)) {
      throw new LlmError('timeout', `LLM 请求超时（${plan.timeoutMs}ms）`);
    }
    throw new LlmError(
      'network',
      `网络错误：${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!res.ok) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    const text = await res.text().catch(() => '');
    throw classifyHttpError(res.status, res.statusText, text);
  }

  if (!res.body) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    throw new LlmError('response_shape', 'LLM 响应没有 body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let yieldedAny = false;

  try {
    // SSE 事件循环
    // 兼容 \r\n 与 \n 两种换行
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, nl);
        const eolLen = buffer[nl] === '\r' ? 2 : 1;
        buffer = buffer.slice(nl + eolLen);

        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload) as ChatCompletionResponse;
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            yieldedAny = true;
            yield delta;
          }
        } catch {
          // 忽略畸形 chunk，继续
        }
      }
    }
    // flush 最后一行（少数 endpoint 不带 trailing newline）
    const trailing = buffer.trim();
    if (trailing.startsWith('data:')) {
      const payload = trailing.slice(5).trim();
      if (payload !== '[DONE]') {
        try {
          const json = JSON.parse(payload) as ChatCompletionResponse;
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            yieldedAny = true;
            yield delta;
          }
        } catch {
          // ignore
        }
      }
    }
    if (!yieldedAny) {
      throw new LlmError('response_shape', '流式响应没有产生任何 content');
    }
  } catch (err) {
    if (isAbortError(err)) {
      throw new LlmError('timeout', `流式 LLM 在 ${plan.timeoutMs}ms 内未完成或被取消`);
    }
    if (err instanceof LlmError) throw err;
    throw new LlmError(
      'network',
      `流式读取失败：${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: unknown }).name === 'AbortError'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
