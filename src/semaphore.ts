/**
 * 简单计数信号量。用途：限制同时进行中的 LLM 调用并发数。
 *
 * 场景：用户在 5 个文件上连点 [📖]，没有限流的话会同时打 5 个 LLM 请求，
 * DeepSeek 免费档会 429。默认 max=2 保证不超载。
 *
 * 语义：acquire() 拿到一个许可才能继续；finally release() 归还。
 * release() 唤醒等待者时，许可直接转手——总许可数不变。
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    if (max < 1) throw new Error('Semaphore max must be ≥ 1');
    this.available = max;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.available--;
        resolve();
      });
    });
  }

  release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** 包装一个异步任务，确保 acquire/release 配对，包括异常路径 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
