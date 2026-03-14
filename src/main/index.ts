import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';

import { loadEnvironment } from './services/env.js';
import { DocumentController } from './services/document-controller.js';
import { Logger } from './services/logger.js';
import { OpenAiDocumentAnalyzer } from './services/openai-analyzer.js';
import { SettingsStore } from './services/settings.js';
import { SUPPORTED_DOCUMENT_EXTENSIONS, type AnalyzeDocumentsRequest, type Diagnostics, type SaveSettingsInput } from '../../shared/types.js';

let mainWindow: BrowserWindow | null = null;
let controller: DocumentController | null = null;
let diagnosticsState: Diagnostics | null = null;
let loggerRef: Logger | null = null;
let ipcRegistered = false;
const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function bootstrap(): Promise<void> {
  const executablePath = app.getPath('exe');
  const cwd = process.cwd();
  const envPath = loadEnvironment(executablePath, cwd);

  const userDataPath = app.getPath('userData');
  const logger = new Logger(path.join(userDataPath, 'logs', 'app.log'));
  await logger.init();
  loggerRef = logger;

  logger.info('Application starting', { executablePath, cwd, envPath });

  const settingsStore = new SettingsStore(path.join(userDataPath, 'settings.json'));
  const analyzer = new OpenAiDocumentAnalyzer({
    getApiKey: () => process.env.OPENAI_API_KEY,
    getModel: async () => (await settingsStore.load()).openaiModel,
  });
  controller = new DocumentController(settingsStore, analyzer, logger);
  diagnosticsState = {
    apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
    cwd,
    envPath,
    executablePath,
    logPath: logger.filePath,
    settingsPath: settingsStore.filePath,
    supportedExtensions: [...SUPPORTED_DOCUMENT_EXTENSIONS],
  };

  if (!ipcRegistered) {
    registerIpcHandlers();
    ipcRegistered = true;
  }

  await createWindow();
}

async function createWindow(): Promise<void> {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 720,
    title: 'PDF Renamer',
    backgroundColor: '#06121c',
    webPreferences: {
      preload: path.join(moduleDir, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    await mainWindow.loadFile(path.resolve(moduleDir, '../renderer/index.html'));
  }
}

function requireController(): DocumentController {
  if (!controller) {
    throw new Error('アプリケーションの初期化が完了していません。');
  }
  return controller;
}

function requireDiagnostics(): Diagnostics {
  if (!diagnosticsState) {
    throw new Error('診断情報がまだ利用できません。');
  }
  return diagnosticsState;
}

function registerIpcHandlers(): void {
  ipcMain.handle('settings:get', async () => requireController().loadSettings());
  ipcMain.handle('settings:save', async (_event, input: SaveSettingsInput) => requireController().saveSettings(input));
  ipcMain.handle('models:list', async () => requireController().listModels());

  ipcMain.handle('documents:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Documents',
          extensions: SUPPORTED_DOCUMENT_EXTENSIONS.map((extension) => extension.replace('.', '')),
        },
      ],
    });

    if (result.canceled) {
      return requireController().listDocuments();
    }

    return requireController().addDocuments(result.filePaths);
  });

  ipcMain.handle('documents:add', async (_event, paths: string[]) => requireController().addDocuments(paths));
  ipcMain.handle('documents:list', async () => requireController().listDocuments());
  ipcMain.handle('documents:clear', async () => requireController().clearDocuments());
  ipcMain.handle('documents:analyze', async (_event, request?: AnalyzeDocumentsRequest) => requireController().analyzeDocuments(request?.keys));
  ipcMain.handle('documents:retry', async (_event, request?: AnalyzeDocumentsRequest) => requireController().retryDocuments(request?.keys));
  ipcMain.handle('documents:rename', async (_event, request?: AnalyzeDocumentsRequest) => requireController().renameDocuments(request?.keys));
  ipcMain.handle('documents:skip', async (_event, request?: AnalyzeDocumentsRequest) => requireController().skipDocuments(request?.keys));
  ipcMain.handle('documents:update-proposed-name', async (_event, request) => requireController().updateProposedName(request));
  ipcMain.handle('documents:open', async (_event, key: string) => {
    const item = requireController().store.get(key);
    if (!item) {
      throw new Error('対象ドキュメントが見つかりません。');
    }
    await shell.openPath(item.currentPath);
  });
  ipcMain.handle('documents:reveal', async (_event, key: string) => {
    const item = requireController().store.get(key);
    if (!item) {
      throw new Error('対象ドキュメントが見つかりません。');
    }
    shell.showItemInFolder(item.currentPath);
  });
  ipcMain.handle('app:get-diagnostics', async () => requireDiagnostics());

  app.on('window-all-closed', () => {
    loggerRef?.info('All windows closed');
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}

app.whenReady().then(async () => {
  await bootstrap();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});
