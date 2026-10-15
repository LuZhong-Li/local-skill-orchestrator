import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

const here = import.meta.dirname;

/**
 * Electron 的构建配置。
 *
 * 三个入口各司其职：主进程负责窗口与内核桥接，预加载脚本只暴露最小白名单接口，
 * 渲染层是纯视图，不含任何 Node 能力。
 * 内核不进打包产物：它以独立子进程形态运行，由主进程按路径调用（AD-09）。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: { input: resolve(here, 'main/index.ts') },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve(here, 'preload/index.ts'),
        // 沙箱化的预加载脚本必须是 CommonJS：ESM 预加载在 sandbox 下无法加载，
        // 而预加载正是渲染层唯一能接触内核的通道，加载失败会让界面静默失效
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(here, 'renderer'),
    plugins: [vue()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(here, 'renderer/index.html') },
    },
  },
});
