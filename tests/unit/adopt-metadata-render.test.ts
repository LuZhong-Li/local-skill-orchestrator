import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSourceOf } from '../../kernel/dispatch/host/index.ts';
import { makeTempDir } from '../helpers/temp.ts';

test('T3 renderSource：兼容性、allowed_tools 与 extensions 不丢失', () => {
  const dir = makeTempDir('sm-t3-render-source-');
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: render-source\n---\n\n# body\n');
  const source = renderSourceOf(dir, {
    id: 'render-source',
    description: 'render source',
    compatibility: 'Agent Skills',
    allowed_tools: 'Read Grep',
    extensions: {
      activation: '/render-source',
      'mcp-server': { command: 'example' },
    },
  });

  assert.equal(source.compatibility, 'Agent Skills');
  assert.equal(source.allowed_tools, 'Read Grep');
  assert.deepEqual(source.extensions, {
    activation: '/render-source',
    'mcp-server': { command: 'example' },
  });
});
