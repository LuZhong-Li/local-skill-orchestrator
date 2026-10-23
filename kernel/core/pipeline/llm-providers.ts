/**
 * LLM Provider 实现。
 *
 * 支持 OpenAI 兼容的 API（Doubao、Claude、GPT 等）。
 */

import type { IntelligenceProvider } from './types.ts';

/** LLM 配置 */
export interface LLMProviderConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/** 消息格式 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** OpenAI 兼容的响应格式 */
interface ChatCompletionResponse {
  choices: Array&lt;{
    message: {
      content: string;
    };
  }&gt;;
}

/**
 * OpenAI 兼容的 LLM Provider。
 *
 * 支持：
 * - Doubao（豆包）
 * - Claude
 * - GPT
 * - 其他 OpenAI 兼容的 API
 */
export class OpenAICompatibleProvider implements IntelligenceProvider {
  readonly name: string;
  private readonly config: LLMProviderConfig;

  constructor(name: string, config: LLMProviderConfig) {
    this.name = name;
    this.config = {
      model: 'gpt-4o-mini',
      temperature: 0.7,
      maxTokens: 2000,
      baseURL: 'https://api.openai.com/v1',
      ...config,
    };
  }

  async generate(prompt: string, context: Record<string, unknown>): Promise&lt;string&gt; {
    const systemPrompt = this.buildSystemPrompt(context);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ];

    const response = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM API call failed (${response.status}): ${errorText}`);
    }

    const data: ChatCompletionResponse = await response.json();
    return data.choices[0].message.content || '';
  }

  private buildSystemPrompt(context: Record<string, unknown>): string {
    const docType = context.docType as string || '文档';
    const topic = context.topic as string || '未指定主题';

    return `你是一个专业的技术文档写作助手。
请根据用户的问题，生成一份高质量的${docType}。
文档内容应该清晰、结构良好、实用性强。
当前主题：${topic}`;
  }
}

/**
 * 创建豆包 (Doubao) Provider
 */
export function createDoubaoProvider(config: LLMProviderConfig): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider('doubao', {
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'ep-20241203182217-q5666',
    ...config,
  });
}

/**
 * 创建 Claude Provider
 */
export function createClaudeProvider(config: LLMProviderConfig): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider('claude', {
    baseURL: 'https://api.anthropic.com/v1',
    model: 'claude-3-haiku-20240307',
    ...config,
  });
}