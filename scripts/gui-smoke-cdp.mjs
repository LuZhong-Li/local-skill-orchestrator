/** Minimal Chrome DevTools Protocol connection used by GUI smoke tests. */
export async function waitForTarget(port, timeoutMs) {
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

export function connectDebugger(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  });

  const rejectPending = (message) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pending.clear();
  };
  socket.addEventListener('close', () => rejectPending('调试通道已关闭'));
  socket.addEventListener('error', () => rejectPending('调试通道连接失败'));

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
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`调试调用超时：${method}`));
        }, 30000);
        pending.set(id, { resolve, reject, timer });
      });
    },
  };
}
