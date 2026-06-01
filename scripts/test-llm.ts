/**
 * Step 2 smoke test：不通过 VS Code 直接跑 LLM，看输出格式。
 *
 * 用法：
 *   export XI_CMT_API_KEY=sk-xxx
 *   export XI_CMT_BASE_URL=https://api.deepseek.com/v1     # 可省，默认 deepseek
 *   export XI_CMT_MODEL=deepseek-chat                      # 可省
 *   export XI_CMT_FILE=fixtures/sample.ts                  # 可省，默认 fixtures/sample.ts
 *   npm run test:llm
 *
 * Ollama 本地：
 *   export XI_CMT_BASE_URL=http://localhost:11434/v1
 *   export XI_CMT_MODEL=qwen2.5-coder:7b
 *   unset XI_CMT_API_KEY    # 本地无 key
 *   npm run test:llm
 *
 * 输出会做一次锚点保留率统计：原文 N 行 → 输出抓到 M 个 L<k>: 锚点 → 命中率 = M/N。
 * Step 3 软校验目标是 ≥ 95%（缺失 ≤ 5%）。Step 2 我们看 ≥ 80% 就可以往下走。
 */

import * as fs from 'fs';
import * as path from 'path';
import { annotate, LlmError, LlmSettings } from '../src/llm';
import { ANCHOR_LINE_RE } from '../src/prompt';
import { parse, validate, render, ConsistencyError } from '../src/parser';

async function main(): Promise<void> {
  const file = process.env.XI_CMT_FILE ?? 'fixtures/sample.ts';
  const baseURL = process.env.XI_CMT_BASE_URL ?? 'https://api.deepseek.com/v1';
  const model = process.env.XI_CMT_MODEL ?? 'deepseek-chat';
  const apiKey = process.env.XI_CMT_API_KEY;
  const timeoutMs = Number(process.env.XI_CMT_TIMEOUT_MS ?? '120000');

  const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error(`[test-llm] 文件不存在: ${abs}`);
    process.exit(1);
  }
  const source = fs.readFileSync(abs, 'utf8');
  const totalLines = source.split('\n').length;

  console.error(`[test-llm] 文件: ${abs}`);
  console.error(`[test-llm] 行数: ${totalLines}`);
  console.error(`[test-llm] baseURL: ${baseURL}`);
  console.error(`[test-llm] model: ${model}`);
  console.error(`[test-llm] apiKey: ${apiKey ? '****' + apiKey.slice(-4) : '(none, local mode)'}`);
  console.error(`[test-llm] 开始调用 LLM...`);

  const settings: LlmSettings = {
    baseURL,
    model,
    apiKey,
    timeoutMs,
    languageId: inferLanguageId(abs),
    commentLanguage: 'zh-CN',
  };

  const t0 = Date.now();
  let output: string;
  try {
    output = await annotate(source, settings);
  } catch (err) {
    if (err instanceof LlmError) {
      console.error(`\n[test-llm] LLM 失败 (${err.kind}${err.status ? ' / HTTP ' + err.status : ''}):`);
      console.error(err.message);
    } else {
      console.error(`\n[test-llm] 未分类错误:`, err);
    }
    process.exit(2);
  }
  const dt = Date.now() - t0;
  console.error(`[test-llm] 完成，用时 ${(dt / 1000).toFixed(1)}s，输出 ${output.length} 字节`);

  // 粗略锚点保留率（不去末尾空行 → 与 Step 2 数字一致供参考）
  const rawAnchors = new Set<number>();
  for (const line of output.split('\n')) {
    const m = line.match(ANCHOR_LINE_RE);
    if (m) rawAnchors.add(Number(m[1]));
  }
  const rawRate = (rawAnchors.size / totalLines) * 100;
  console.error(`[test-llm] 锚点保留率 (含末尾空行口径): ${rawAnchors.size}/${totalLines} = ${rawRate.toFixed(1)}%`);

  // 写入 raw 输出文件
  const rawOutFile = path.join(path.dirname(abs), path.basename(abs).replace(/\.([^.]+)$/, '.llm-output.$1.txt'));
  fs.writeFileSync(rawOutFile, output, 'utf8');
  console.error(`[test-llm] LLM 原始输出: ${rawOutFile}`);

  // 跑 Step 3 parser + validate + render
  console.error('');
  console.error(`[test-llm] 跑 Step 3 parser + 软校验...`);
  const { parsed, trailingComments } = parse(output);
  try {
    const stats = validate(parsed, source);
    console.error(
      `[test-llm] ✅ 软校验通过：命中 ${stats.anchorsHit}/${stats.anchorsExpected} (${(stats.hitRate * 100).toFixed(1)}%), mismatch ${stats.mismatches} (${(stats.mismatchRate * 100).toFixed(1)}%)`
    );
  } catch (err) {
    if (err instanceof ConsistencyError) {
      console.error(`[test-llm] ❌ 软校验失败：${err.message}`);
      console.error(`[test-llm]    命中 ${err.anchorsHit}/${err.anchorsExpected}, mismatch ${err.mismatches}`);
      process.exit(3);
    }
    throw err;
  }
  const renderedOut = render(parsed, source, trailingComments);
  const renderedFile = path.join(path.dirname(abs), path.basename(abs).replace(/\.([^.]+)$/, '.rendered.$1.txt'));
  fs.writeFileSync(renderedFile, renderedOut, 'utf8');
  console.error(`[test-llm] 渲染后（用户最终看到的样子）: ${renderedFile}`);
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
  console.error('[test-llm] 未捕获错误:', err);
  process.exit(99);
});
