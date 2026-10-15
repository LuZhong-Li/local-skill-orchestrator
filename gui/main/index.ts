/**
 * Electron 主进程：窗口、生命周期与内核桥接的装配。
 *
 * 边界：主进程只做两件事——把渲染层的请求转成一次内核调用，把内核结果原样回传；
 * 不解释业务语义，也不直接读写工作区的任何文件。
 */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { KernelBridge } from '../bridge/commands.ts';
import type { KernelOptions } from '../bridge/kernel.ts';

/** 主进程以 ES 模块运行，没有 __dirname，从模块地址推导 */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * 解析内核调用参数。
 * 开发模式默认用 node 跑仓库内的内核入口；打包后默认调用随包分发的独立可执行文件。
 * 三者都可用环境变量覆盖，便于换环境调试。
 */
function resolveKernelOptions(): KernelOptions {
  const workspace =
    process.env['SKILL_MANAGER_WORKSPACE'] ??
    process.env['SKILL_MANAGER_HOME'] ??
    join(homedir(), '.skill-manager');

  const packaged = app.isPackaged;
  const defaultCommand = packaged
    ? join(process.resourcesPath, 'kernel', 'skill-manager.exe')
    : 'node';
  const defaultEntry = packaged
    ? []
    : [resolve(app.getAppPath(), '..', 'kernel', 'entry', 'cli.ts')];

  const command = process.env['SKILL_MANAGER_KERNEL_COMMAND'] ?? defaultCommand;
  const entryEnv = process.env['SKILL_MANAGER_KERNEL_ENTRY'];
  const entry =
    entryEnv !== undefined && entryEnv !== '' ? entryEnv.split(' ').filter(Boolean) : defaultEntry;

  return {
    command,
    entry,
    workspace,
    cwd: packaged ? process.resourcesPath : resolve(app.getAppPath(), '..'),
  };
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#F6F5F2',
    title: 'skill-manager',
    // 打包后的窗口与任务栏图标由可执行文件内嵌的图标提供；
    // 开发模式没有内嵌图标，这里显式指向仓库中的图标资源
    ...(app.isPackaged ? {} : { icon: resolve(app.getAppPath(), 'packaging', 'icon.png') }),
    webPreferences: {
      // 渲染层不接触 Node，只经预加载脚本暴露的白名单接口调用内核
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(here, '../preload/index.cjs'),
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer !== undefined && devServer !== '') {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(here, '../renderer/index.html'));
  }
}

function registerKernelHandlers(): void {
  const bridge = new KernelBridge(resolveKernelOptions());

  ipcMain.handle('kernel:describe', () => ({
    workspace: resolveKernelOptions().workspace,
    packaged: app.isPackaged,
    kernelVersion: app.getVersion(),
  }));
  ipcMain.handle('kernel:invoke', (_event, argv: string[]) => bridge.run(argv));
  ipcMain.handle('kernel:preview', (_event, argv: string[]) => bridge.preview(argv));
  ipcMain.handle('kernel:execute', (_event, argv: string[]) => bridge.execute(argv));
}

app.whenReady().then(() => {
  registerKernelHandlers();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
