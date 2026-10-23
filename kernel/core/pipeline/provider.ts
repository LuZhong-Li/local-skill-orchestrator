/** IntelligenceProvider 内置实现。 */

import type { IntelligenceProvider } from './types.ts';

/**
 * Stub 实现：直接返回模板占位文本，不调用外部 API。
 * 用于 M0/M1 开发测试。
 */
export class StubProvider implements IntelligenceProvider {
  readonly name = 'stub';

  async generate(prompt: string, context: Record<string, unknown>): Promise<string> {
    const topic = (context.topic as string) || '未指定主题';
    return `# ${prompt}\n\n待填写：${topic}\n`;
  }
}

/**
 * 人工兜底实现：包装另一个 provider，调用失败时返回空白人工模板。
 * 不抛异常，保证流水线不中断。
 */
export class HumanFallbackProvider implements IntelligenceProvider {
  readonly name = 'human-fallback';
  private readonly inner: IntelligenceProvider;

  constructor(inner: IntelligenceProvider) {
    this.inner = inner;
  }

  async generate(prompt: string, context: Record<string, unknown>): Promise<string> {
    try {
      return await this.inner.generate(prompt, context);
    } catch {
      const docType = (context.docType as string) || '文档';
      return `# ${docType}\n\n（请人工填写）\n`;
    }
  }
}