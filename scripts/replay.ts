/**
 * 离线 replay：从磁盘读「LLM 原始输出」+「原文件」，跑 parse + validate + render。
 * 用途：调 parser/validate 逻辑时不烧 token 重跑 LLM。
 *
 * 用法：
 *   XI_CMT_FILE=fixtures/sample.py npm run replay
 *   # 默认读 fixtures/sample.llm-output.py.txt （由 test:llm 写）
 *
 * 若 .llm-output 文件不存在，提示用户先跑 test:llm。
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse, validate, render, ConsistencyError } from '../src/parser';

function main(): void {
  const file = process.env.XI_CMT_FILE ?? 'fixtures/sample.ts';
  const sourceAbs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  if (!fs.existsSync(sourceAbs)) {
    console.error(`[replay] 原文件不存在: ${sourceAbs}`);
    process.exit(1);
  }
  const llmOutFile = sourceAbs.replace(/\.([^.]+)$/, '.llm-output.$1.txt');
  if (!fs.existsSync(llmOutFile)) {
    console.error(`[replay] LLM 输出文件不存在: ${llmOutFile}`);
    console.error(`[replay] 先跑一次: XI_CMT_FILE=${file} npm run test:llm`);
    process.exit(1);
  }

  const source = fs.readFileSync(sourceAbs, 'utf8');
  const output = fs.readFileSync(llmOutFile, 'utf8');

  console.error(`[replay] 原文: ${sourceAbs}`);
  console.error(`[replay] LLM 输出: ${llmOutFile}`);

  const { parsed, trailingComments } = parse(output);
  try {
    const stats = validate(parsed, source);
    console.error(
      `[replay] ✅ 软校验通过：非空行命中 ${stats.anchorsHit}/${stats.anchorsExpected} (${(stats.hitRate * 100).toFixed(1)}%), mismatch ${stats.mismatches} (${(stats.mismatchRate * 100).toFixed(1)}%)`
    );
  } catch (err) {
    if (err instanceof ConsistencyError) {
      console.error(`[replay] ❌ 软校验失败：${err.message}`);
      console.error(`[replay]    命中 ${err.anchorsHit}/${err.anchorsExpected}, mismatch ${err.mismatches}`);
      process.exit(3);
    }
    throw err;
  }
  const renderedOut = render(parsed, source, trailingComments);
  const renderedFile = sourceAbs.replace(/\.([^.]+)$/, '.rendered.$1.txt');
  fs.writeFileSync(renderedFile, renderedOut, 'utf8');
  console.error(`[replay] 渲染后: ${renderedFile}`);
}

main();
