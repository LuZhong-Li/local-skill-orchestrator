import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MACHO_SEGMENT_NAME,
  SEA_BLOB_RESOURCE,
  SEA_FUSE,
  postjectArgs,
} from '../../scripts/sea-postject.mjs';

const base = { executable: '/tmp/kernel', blob: '/tmp/kernel.blob' };

test('SEA 注入参数：三平台共同部分（资源名 / blob / 哨兵值）', () => {
  for (const platform of ['linux', 'win32', 'darwin']) {
    const args = postjectArgs({ ...base, platform });
    assert.equal(args[0], base.executable);
    assert.equal(args[1], SEA_BLOB_RESOURCE);
    assert.equal(args[2], base.blob);
    assert.deepEqual(args.slice(3, 5), ['--sentinel-fuse', SEA_FUSE]);
  }
});

test('SEA 注入参数：macOS 必须带 --macho-segment-name NODE_SEA（EX-13 根因）', () => {
  assert.deepEqual(postjectArgs({ ...base, platform: 'darwin' }).slice(5), [
    '--macho-segment-name',
    MACHO_SEGMENT_NAME,
  ]);
  assert.equal(MACHO_SEGMENT_NAME, 'NODE_SEA');
  for (const platform of ['linux', 'win32']) {
    assert.equal(
      postjectArgs({ ...base, platform }).includes('--macho-segment-name'),
      false,
      `${platform} 不加段名参数（官方口径：仅 macOS 需要）`,
    );
  }
});
