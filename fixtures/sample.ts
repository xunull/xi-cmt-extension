// 用于 Step 1 视图原型验证的示例文件。
// 在 Extension Development Host 里打开这个文件，按右上角 [📖] 按钮，
// 应该在右侧 column 打开 fixtures/sample.cmt.ts，每 5 行有一条占位注释。

import * as crypto from 'crypto';

export interface User {
  id: string;
  name: string;
  createdAt: Date;
}

export class UserStore {
  private users = new Map<string, User>();

  add(name: string): User {
    const id = crypto.randomBytes(8).toString('hex');
    const user: User = { id, name, createdAt: new Date() };
    this.users.set(id, user);
    return user;
  }

  get(id: string): User | undefined {
    return this.users.get(id);
  }

  delete(id: string): boolean {
    return this.users.delete(id);
  }

  size(): number {
    return this.users.size;
  }
}

export function greet(user: User): string {
  return `Hello, ${user.name}! You joined at ${user.createdAt.toISOString()}.`;
}
