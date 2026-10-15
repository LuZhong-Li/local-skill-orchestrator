#!/usr/bin/env node
/**
 * 桌面外壳的冒烟检查：启动 Electron，经 DevTools 协议确认界面真的渲染成功，
 * 并走一遍「空工作区引导 → 初始化 → 扫描 → 卡片列表」的真实链路。
 *
 * 这条检查补的是自动化盲区：单元测试覆盖内核与桥接层，但「窗口是否真的画出来、
 * 渲染层能否经预加载脚本调通内核」只有把应用跑起来才能确认。
 * 用法：node scripts/gui-smoke.mjs（开发产物）
 *       node scripts/gui-smoke.mjs --app <可执行文件路径>（针对打包产物，需要图形会话）
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUI = join(ROOT, 'gui');

/**
 * 每次运行取一个空闲端口：固定端口会把探针连到上一次遗留的实例上，
 * 那种「连得上但状态不对」的假象比连不上更难排查。
 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** 结束整个进程树：Electron 会派生辅助进程，只杀直接子进程会留下占用端口的实例 */
function killTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

/** 指定 --app 时直接运行打包后的可执行文件，否则运行开发产物 */
const appIndex = process.argv.indexOf('--app');
const packagedApp = appIndex >= 0 ? process.argv[appIndex + 1] : undefined;

function prepareWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'sm-gui-smoke-'));
  const skill = join(root, 'skills', 'smoke-skill');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# smoke');
  writeFileSync(
    join(skill, 'skill_meta.yaml'),
    [
      'id: smoke-skill',
      'name: smoke-skill',
      'version: 1.0.0',
      'status: enabled',
      'path: ./skills/smoke-skill',
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: global',
      '    path: .claude/skills/smoke-skill',
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: SKILL.md',
      '',
    ].join('\n'),
  );
  return root;
}

async function waitForTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        (item) => item.type === 'page' && !String(item.url).startsWith('devtools://'),
      );
      if (page !== undefined) return page;
    } catch {
      // 端口尚未就绪，继续等
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('等待渲染层目标超时');
}

function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const resolver = pending.get(message.id);
    if (resolver !== undefined) {
      pending.delete(message.id);
      resolver(message);
    }
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(undefined));
    socket.addEventListener('error', () => reject(new Error('调试通道连接失败')));
  });
  return {
    ready,
    close: () => socket.close(),
    send(method, params) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve) => pending.set(id, resolve));
    },
  };
}

async function main() {
  const PORT = await freePort();
  const workspace = prepareWorkspace();
  const electron =
    packagedApp ??
    join(
      existsSync(join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'))
        ? join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
        : join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
    );
  const child = spawn(
    electron,
    [...(packagedApp === undefined ? ['.'] : []), `--remote-debugging-port=${PORT}`],
    {
      cwd: GUI,
      env: { ...process.env, SKILL_MANAGER_WORKSPACE: workspace },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const diagnostics = [];

  try {
    const target = await waitForTarget(PORT, 30000);
    diagnostics.push(`目标页面：${String(target.url)}｜${String(target.title)}`);
    const client = connect(target.webSocketDebuggerUrl);
    await client.ready;

    const evaluate = async (expression) => {
      const response = await client.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return response.result?.result?.value;
    };

    diagnostics.push(
      `渲染层地址：${String(await evaluate('location.href'))}｜标题：${String(await evaluate('document.title'))}`,
    );
    diagnostics.push(`正文本地长度：${String(await evaluate('document.body.innerText.length'))}`);
    diagnostics.push(`预加载接口：${String(await evaluate('typeof window.skillManager?.invoke'))}`);
    diagnostics.push(
      `直接经预加载调用一次 list：${String(
        await evaluate(
          "window.skillManager.invoke(['list']).then((r) => r.command + '/' + r.exit_code)",
        ),
      )}`,
    );
    diagnostics.push(
      `当前按钮：${String(
        await evaluate(
          "[...document.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|')",
        ),
      )}`,
    );

    // 等界面把首次 list 调用跑完
    for (let index = 0; index < 40; index += 1) {
      const ready = await evaluate("document.body.innerText.includes('skill-manager')");
      if (ready === true) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const waitFor = async (expression, attempts = 40) => {
      for (let index = 0; index < attempts; index += 1) {
        if ((await evaluate(expression)) === true) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return false;
    };

    check(
      '窗口渲染出侧边导航',
      (await evaluate("document.querySelector('aside h1')?.textContent === 'skill-manager'")) ===
        true,
    );
    check(
      '未初始化时显示引导而非错误',
      await waitFor("document.body.innerText.includes('工作区尚未初始化')"),
    );

    await evaluate(
      "[...document.querySelectorAll('button')].find((b) => b.textContent.includes('初始化工作区'))?.click()",
    );
    for (let index = 0; index < 40; index += 1) {
      const done = await evaluate("document.body.innerText.includes('还没有已管理的 Skill')");
      if (done === true) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    check(
      '初始化后进入空列表引导',
      (await evaluate("document.body.innerText.includes('还没有已管理的 Skill')")) === true,
    );

    await evaluate(
      "[...document.querySelectorAll('button')].find((b) => b.textContent.includes('立即扫描'))?.click()",
    );
    await waitFor("document.querySelectorAll('article.card').length > 0", 60);
    const cards = Number(await evaluate("document.querySelectorAll('article.card').length"));
    check('扫描后仪表盘展示真实 Skill 卡片', cards === 1, `卡片数 ${String(cards)}`);
    if (cards === 0) {
      diagnostics.push(
        `扫描后正文：${String(await evaluate('document.body.innerText')).slice(0, 400)}`,
      );
    }
    check(
      '卡片状态标签取自内核结论',
      (await evaluate("document.querySelector('article.card .tag')?.textContent")) === '已启用',
    );
    check(
      '状态栏记录了内核调用',
      (await evaluate("document.querySelector('.statusbar')?.innerText.includes('scan')")) === true,
    );

    client.close();
  } finally {
    killTree(child);
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(workspace, { recursive: true, force: true });
  }

  for (const item of checks) {
    console.log(
      `${item.ok ? '✔' : '✖'} ${item.name}${item.detail === '' ? '' : `（${item.detail}）`}`,
    );
  }
  if (diagnostics.length > 0) {
    console.log('--- 诊断 ---');
    for (const line of diagnostics) console.log(line);
  }
  if (stderr.trim() !== '') {
    console.log('--- 主进程诊断输出 ---');
    console.log(stderr.trim().split('\n').slice(0, 10).join('\n'));
  }
  const failed = checks.filter((item) => !item.ok);
  console.log(`\n界面冒烟：${checks.length - failed.length}/${checks.length} 通过`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
