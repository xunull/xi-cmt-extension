import * as vscode from 'vscode';
import { CmtContentProvider, CMT_SCHEME, buildCmtUri, ErrorEvent } from './contentProvider';
import { Linemap } from './linemap';
import { clearAllCaches } from './cache';
import { LlmError } from './llm';
import { ConsistencyError } from './parser';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new CmtContentProvider(context);

  // 状态栏：分块生成进度
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.tooltip = 'xi-cmt: 注释生成进度';

  // isSyncing + debounce 状态（双向滚动防循环）
  let isSyncing = false;
  let scrollDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  context.subscriptions.push(
    statusBar,
    vscode.workspace.registerTextDocumentContentProvider(CMT_SCHEME, provider),

    // 分块状态事件 → 更新状态栏
    provider.onStatus((ev) => {
      if (ev.done) {
        statusBar.hide();
      } else {
        statusBar.text = `📖 生成中 [${ev.completedChunks}/${ev.totalChunks} 块]`;
        statusBar.show();
      }
    }),

    // 双向同步滚动
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (isSyncing) return;

      clearTimeout(scrollDebounceTimer);
      scrollDebounceTimer = setTimeout(() => {
        const { textEditor, visibleRanges } = e;
        const isAnnotated = textEditor.document.uri.scheme === CMT_SCHEME;

        if (isAnnotated) {
          // 注释视图 → 原始文件
          const linemap = provider.getLinemap(textEditor.document.uri);
          if (!linemap?.isComplete) return;

          const annotatedLine0 = visibleRanges[0]?.start.line ?? 0;
          const origLine0 = linemap.getOriginal(annotatedLine0);
          if (origLine0 === undefined) return;

          const origEditor = findOriginalEditorFor(textEditor, provider);
          if (!origEditor) return;

          isSyncing = true;
          origEditor.revealRange(
            new vscode.Range(origLine0, 0, origLine0, 0),
            vscode.TextEditorRevealType.AtTop
          );
          setTimeout(() => { isSyncing = false; }, 150);

        } else {
          // 原始文件 → 注释视图
          const cmtUriStr = provider.getCmtUriStringForOriginal(textEditor.document.uri);
          if (!cmtUriStr) return;

          const cmtUri = vscode.Uri.parse(cmtUriStr);
          const linemap = provider.getLinemap(cmtUri);
          if (!linemap?.isComplete) return;

          const origLine0 = visibleRanges[0]?.start.line ?? 0;
          const annLine0 = linemap.getAnnotated(origLine0);
          if (annLine0 === undefined) return;

          const annEditor = vscode.window.visibleTextEditors.find(
            (ed) => ed.document.uri.toString() === cmtUriStr
          );
          if (!annEditor) return;

          isSyncing = true;
          annEditor.revealRange(
            new vscode.Range(annLine0, 0, annLine0, 0),
            vscode.TextEditorRevealType.AtTop
          );
          setTimeout(() => { isSyncing = false; }, 150);
        }
      }, 50);
    }),

    // 文件保存：记录事件（目前不自动失效，用户通过 xi-cmt.regenerate 主动刷新）
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === CMT_SCHEME) return;
      const cmtUriStr = provider.getCmtUriStringForOriginal(doc.uri);
      if (!cmtUriStr) return;
      // 文件已变更，注释视图可能过期——不自动失效以免打断用户阅读
      // 未来可在此处添加状态栏提示
    }),

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
      const originalLine0 = editor.visibleRanges[0]?.start.line ?? 0;

      await vscode.window.showTextDocument(cmtUri, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
        preserveFocus: false,
      });

      // 打开后对齐视口：linemap 已就绪则立即跳转；否则注册一次性回调
      const existingLinemap = provider.getLinemap(cmtUri);
      if (existingLinemap) {
        doInitialReveal(cmtUri, originalLine0, existingLinemap);
      } else {
        provider.onLinemapReadyOnce(cmtUri, (lm) => {
          doInitialReveal(cmtUri, originalLine0, lm);
        });
      }
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
      const confirm = await vscode.window.showWarningMessage(
        `xi-cmt: 即将清理 ~/.cache/xi-cmt/ 下的所有注释缓存。继续？`,
        { modal: true },
        '清理'
      );
      if (confirm !== '清理') return;
      try {
        const result = await clearAllCaches();
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

function doInitialReveal(cmtUri: vscode.Uri, originalLine0: number, linemap: Linemap): void {
  const annEditor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === cmtUri.toString()
  );
  if (!annEditor) return;
  revealAtOriginalLine(originalLine0, linemap, annEditor);
}

function revealAtOriginalLine(
  originalLine0: number,
  linemap: Linemap,
  annotatedEditor: vscode.TextEditor
): void {
  const ann = linemap.getAnnotated(originalLine0);
  if (ann === undefined) return;
  annotatedEditor.revealRange(
    new vscode.Range(ann, 0, ann, 0),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport
  );
}

function findOriginalEditorFor(
  annotatedEditor: vscode.TextEditor,
  provider: CmtContentProvider
): vscode.TextEditor | undefined {
  const origUriStr = provider.getOriginalUriStringForCmt(annotatedEditor.document.uri);
  if (!origUriStr) return undefined;
  return vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === origUriStr
  );
}

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
        pick =
          sel === '切换 model'
            ? 'switchModel'
            : sel === '打开设置'
              ? 'openSettings'
              : sel === '重试'
                ? 'retry'
                : undefined;
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
        const sel = await vscode.window.showErrorMessage(`xi-cmt: ${error.message}`, '重试');
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
