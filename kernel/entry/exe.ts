#!/usr/bin/env node
/**
 * 可执行形态的内核入口。
 *
 * 与源码形态的入口共用同一套指令实现，区别只有两点：
 *   不做「是否作为入口被直接执行」的判定——打包后的可执行文件就是入口本身；
 *   把退出码原样交给进程，供宿主按退出码派生规则处理。
 *
 * 这一层不含任何业务逻辑。
 */
import { run } from './cli.ts';

// 不用顶层 await：单文件可执行只支持 CommonJS，而顶层 await 无法打包为 CommonJS
void run(process.argv.slice(2)).then((code) => {
  process.exit(code);
});
