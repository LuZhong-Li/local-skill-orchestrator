import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { prepareUserData } from '../../scripts/gui-smoke-fixtures.mjs';
import { makeTempDir } from '../helpers/temp.ts';

test('GUI smoke 固定初始语言为 zh-CN，不受 runner 系统语言影响', () => {
  const root = makeTempDir('sm-gui-user-data-test-');
  prepareUserData(root);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')), {
    language: { mode: 'manual', value: 'zh-CN' },
  });
});
