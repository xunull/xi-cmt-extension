import * as vscode from 'vscode';
import { CmtContentProvider, CMT_SCHEME, buildCmtUri, ErrorEvent } from './contentProvider';
import { clearAllCaches } from './cache';
import { LlmError } from './llm';
import { ConsistencyError } from './parser';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new CmtContentProvider(context);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(CMT_SCHEME, provider),
    vscode.commands.registerCommand('xi-cmt.openPreview', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('请先在编辑器中打开一个源码文件。');
        return;
      }
      const doc = editor.document;
      if (doc.uri.scheme === CMT_SCHEME) {
        vscode.window.showInformationMessage('当前已经是 xi-cmt 注释视图。');
        return;
      }

      const cfg = vscode.workspace.getConfiguration('xi-cmt');
      const model = cfg.get<string>('model', 'deepseek-chat');
      const cmtUri = buildCmtUri(doc.uri, doc.getText(), model);

      await vscode.window.showTextDocument(cmtUri, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
        preserveFocus: false,
      });
    }),
    vscode.commands.registerCommand('xi-cmt.regenerate', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== CMT_SCHEME) {
        vscode.window.showWarningMessage('请把焦点放在 xi-cmt 注释视图（右侧 .cmt.* 文件）上再触发。');
        return;
      }
      provider.invalidate(editor.document.uri);
    }),
    vscode.commands.registerCommand('xi-cmt.setApiKey', async () => {
      const input = await vscode.window.showInputBox({
        prompt: 'xi-cmt: 输入 OpenAI 兼容 API Key（Ollama 等本地服务可留空）',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-...',
      });
      if (input === undefined) return;
      if (input === '') {
        await context.secrets.delete('xi-cmt.apiKey');
        vscode.window.showInformationMessage('xi-cmt: API Key 已清除。');
      } else {
        await context.secrets.store('xi-cmt.apiKey', input);
        vscode.window.showInformationMessage('xi-cmt: API Key 已保存到系统 keychain。');
      }
    }),
    vscode.commands.registerCommand('xi-cmt.clearCache', async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const confirm = await vscode.window.showWarningMessage(
        `xi-cmt: 即将清理 ${folders.length} 个 workspace 的 .vscode/.cmt-cache/ 与 ~/.cache/xi-cmt/ 下的所有 .cmt 缓存。继续？`,
        { modal: true },
        '清理'
      );
      if (confirm !== '清理') return;
      try {
        const result = await clearAllCaches(folders);
        provider.invalidateAll();
        vscode.window.showInformationMessage(
          `xi-cmt: 已清理 ${result.removed} 个缓存文件（扫描 ${result.scannedDirs.length} 个目录）。`
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `xi-cmt: 缓存清理失败：${err instanceof Error ? err.message : String(err)}`
        );
      }
    }),
    provider.onError(async (ev) => {
      await handleProviderError(ev, provider);
    })
  );
}

/**
 * 统一的错误 UX：弹窗 + 一键修复按钮。
 * 不同 err 种类提供不同操作（设置 key / 打开设置 / 重试 / 切 model）。
 */
async function handleProviderError(ev: ErrorEvent, provider: CmtContentProvider): Promise<void> {
  const { uri, error } = ev;

  type Action = 'retry' | 'setKey' | 'openSettings' | 'switchModel' | undefined;
  let pick: Action;

  if (error instanceof LlmError) {
    switch (error.kind) {
      case 'invalid_config':
      case 'auth': {
        const sel = await vscode.window.showErrorMessage(
          `xi-cmt: ${error.message}`,
          '设置 API Key',
          '打开设置'
        );
        pick = sel === '设置 API Key' ? 'setKey' : sel === '打开设置' ? 'openSettings' : undefined;
        break;
      }
      case 'model_not_found': {
        const sel = await vscode.window.showErrorMessage(
          `xi-cmt: model 不存在或 endpoint 错误。${error.message}`,
          '切换 model',
          '打开设置',
          '重试'
        );
        pick = sel === '切换 model' ? 'switchModel' : sel === '打开设置' ? 'openSettings' : sel === '重试' ? 'retry' : undefined;
        break;
      }
      case 'quota': {
        const sel = await vscode.window.showWarningMessage(
          `xi-cmt: 配额/限流。${error.message}`,
          '重试',
          '切换 model'
        );
        pick = sel === '重试' ? 'retry' : sel === '切换 model' ? 'switchModel' : undefined;
        break;
      }
      case 'timeout': {
        const sel = await vscode.window.showWarningMessage(
          `xi-cmt: 请求超时。${error.message}`,
          '重试',
          '打开设置'
        );
        pick = sel === '重试' ? 'retry' : sel === '打开设置' ? 'openSettings' : undefined;
        break;
      }
      case 'network':
      case 'response_shape':
      default: {
        const sel = await vscode.window.showErrorMessage(
          `xi-cmt: ${error.message}`,
          '重试'
        );
        pick = sel === '重试' ? 'retry' : undefined;
        break;
      }
    }
  } else if (error instanceof ConsistencyError) {
    const sel = await vscode.window.showWarningMessage(
      `xi-cmt: LLM 输出软校验失败 (命中 ${error.anchorsHit}/${error.anchorsExpected})。换一个 model 通常能解决。`,
      '重试',
      '切换 model'
    );
    pick = sel === '重试' ? 'retry' : sel === '切换 model' ? 'switchModel' : undefined;
  } else {
    const sel = await vscode.window.showErrorMessage(
      `xi-cmt: ${error instanceof Error ? error.message : String(error)}`,
      '重试'
    );
    pick = sel === '重试' ? 'retry' : undefined;
  }

  switch (pick) {
    case 'retry':
      provider.invalidate(uri);
      return;
    case 'setKey':
      await vscode.commands.executeCommand('xi-cmt.setApiKey');
      return;
    case 'openSettings':
      await vscode.commands.executeCommand('workbench.action.openSettings', 'xi-cmt');
      return;
    case 'switchModel': {
      const cfg = vscode.workspace.getConfiguration('xi-cmt');
      const current = cfg.get<string>('model', 'deepseek-chat');
      const next = await vscode.window.showInputBox({
        prompt: '输入新的 model name（例如 deepseek-chat / kimi-k2-0711-preview / qwen2.5-coder:7b）',
        value: current,
        ignoreFocusOut: true,
      });
      if (next && next !== current) {
        await cfg.update('model', next, vscode.ConfigurationTarget.Global);
        // model 进了 URI query → 旧 cmtUri 已失效，要让用户重新触发 openPreview
        // 这里 invalidate 旧 uri 是为了释放内存状态
        provider.invalidate(uri);
        vscode.window.showInformationMessage(
          `xi-cmt: 已切到 model=${next}。请重新对源码文件运行 "Open Annotated Preview"（旧 .cmt 预览的 URI 与新 model 不匹配）。`
        );
      }
      return;
    }
    default:
      return;
  }
}

export function deactivate(): void {
  // no-op
}
