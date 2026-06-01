/**
 * Step 4 流式 smoke test。把 LLM 流式 chunks 实时打到 stdout，让你眼见为实。
 *
 * 用法（与 test:llm 同一套环境变量）：
 *   XI_CMT_API_KEY=sk-xxx XI_CMT_FILE=fixtures/sample.ts npm run test:stream
 *
 * 期望体验：你会看到字符一段一段往外冒，不是「等 5 秒一次性显示全部」。
 * 终端时间戳显示每段 chunk 到达的相对毫秒数，便于评估 TPS 与首字延迟。
 */

import * as fs from 'fs';
import * as path from 'path';
import { streamAnnotate, LlmError, LlmSettings } from '../src/llm';
import { parse, validate, render, ConsistencyError } from '../src/parser';

async function main(): Promise<void> {
  const file = process.env.XI_CMT_FILE ?? 'fixtures/sample.ts';
  const baseURL = process.env.XI_CMT_BASE_URL ?? 'https://api.deepseek.com/v1';
  const model = process.env.XI_CMT_MODEL ?? 'deepseek-chat';
  const apiKey = process.env.XI_CMT_API_KEY;
  const timeoutMs = Number(process.env.XI_CMT_TIMEOUT_MS ?? '120000');

  const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error(`[test-stream] 文件不存在: ${abs}`);
    process.exit(1);
  }
  const source = fs.readFileSync(abs, 'utf8');

  console.error(`[test-stream] 文件: ${abs}`);
  console.error(`[test-stream] baseURL: ${baseURL}`);
  console.error(`[test-stream] model: ${model}`);
  console.error(`[test-stream] 开始流式调用...\n`);

  const settings: LlmSettings = {
    baseURL,
    model,
    apiKey,
    timeoutMs,
    languageId: inferLanguageId(abs),
    commentLanguage: 'zh-CN',
  };

  const t0 = Date.now();
  let firstChunkAt = -1;
  let chunkCount = 0;
  let totalChars = 0;
  const collected: string[] = [];

  try {
    for await (const chunk of streamAnnotate(source, settings)) {
      chunkCount++;
      totalChars += chunk.length;
      if (firstChunkAt < 0) firstChunkAt = Date.now() - t0;
      collected.push(chunk);
      process.stdout.write(chunk);
    }
  } catch (err) {
    process.stdout.write('\n');
    if (err instanceof LlmError) {
      console.error(`\n[test-stream] LLM 失败 (${err.kind}${err.status ? ' / HTTP ' + err.status : ''}):`);
      console.error(err.message);
    } else {
      console.error(`\n[test-stream] 未分类错误:`, err);
    }
    process.exit(2);
  }

  const dt = Date.now() - t0;
  process.stdout.write('\n');
  console.error('');
  console.error(`[test-stream] ✅ 流完成`);
  console.error(`[test-stream]   总用时: ${(dt / 1000).toFixed(2)}s`);
  console.error(`[test-stream]   首字延迟 (TTFT): ${firstChunkAt}ms`);
  console.error(`[test-stream]   chunks: ${chunkCount}`);
  console.error(`[test-stream]   字符数: ${totalChars}`);
  console.error(
    `[test-stream]   TPS (chunks/s): ${(chunkCount / (dt / 1000)).toFixed(1)}, 字符/s: ${(totalChars / (dt / 1000)).toFixed(0)}`
  );

  const fullOutput = collected.join('');
  const { parsed, trailingComments } = parse(fullOutput);
  try {
    const stats = validate(parsed, source);
    console.error(
      `[test-stream]   软校验: ✅ 非空行命中 ${stats.anchorsHit}/${stats.anchorsExpected} (${(stats.hitRate * 100).toFixed(1)}%), mismatch ${stats.mismatches}`
    );
  } catch (err) {
    if (err instanceof ConsistencyError) {
      console.error(`[test-stream]   软校验: ❌ ${err.message}`);
    } else {
      throw err;
    }
  }

  const renderedFile = abs.replace(/\.([^.]+)$/, '.stream-rendered.$1.txt');
  fs.writeFileSync(renderedFile, render(parsed, source, trailingComments), 'utf8');
  console.error(`[test-stream]   渲染版: ${renderedFile}`);
}

function inferLanguageId(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.go': 'go',
      '.py': 'python',
      '.rs': 'rust',
      '.java': 'java',
      '.cpp': 'cpp',
      '.c': 'c',
      '.rb': 'ruby',
    }[ext] ?? 'plaintext'
  );
}

main().catch((err) => {
  console.error('[test-stream] 未捕获错误:', err);
  process.exit(99);
});
