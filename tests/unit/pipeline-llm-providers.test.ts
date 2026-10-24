/** LLM Provider 测试。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAICompatibleProvider,
  createDoubaoProvider,
  createClaudeProvider,
} from '../../kernel/core/pipeline/llm-providers.ts';

test('OpenAICompatibleProvider: 基本实例化', () => {
  const provider = new OpenAICompatibleProvider('test-provider', {
    apiKey: 'test-key',
  });
  assert.equal(provider.name, 'test-provider');
});

test('createDoubaoProvider: 正确配置', () => {
  const provider = createDoubaoProvider({ apiKey: 'test-key' });
  assert.equal(provider.name, 'doubao');
});

test('createClaudeProvider: 正确配置', () => {
  const provider = createClaudeProvider({ apiKey: 'test-key' });
  assert.equal(provider.name, 'claude');
});

test('OpenAICompatibleProvider: 自定义配置生效', () => {
  const provider = new OpenAICompatibleProvider('custom', {
    apiKey: 'test-key',
    model: 'custom-model',
    temperature: 0.5,
    baseURL: 'https://custom.api/v1',
  });
  assert.equal(provider.name, 'custom');
});
