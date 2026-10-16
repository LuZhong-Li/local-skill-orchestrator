import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ICONSET_ENTRIES,
  ICO_SIZES,
  LINUX_ICON_SIZES,
  buildIconArtifacts,
  sha256,
  writeIconArtifacts,
} from '../../scripts/icon-render.mjs';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 解析 PNG 的 IHDR 宽高（不依赖图形库） */
function pngSize(buffer: Buffer): { width: number; height: number } {
  assert.deepEqual(
    [...buffer.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG 签名不正确',
  );
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR', 'PNG 首块应为 IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

test('图标：各档位 PNG 的像素尺寸与声明一致', () => {
  const artifacts = buildIconArtifacts();

  assert.deepEqual(pngSize(artifacts.png), { width: 256, height: 256 }, 'icon.png 沿用 256 档');
  assert.equal(artifacts.icons.length, LINUX_ICON_SIZES.length, 'Linux 图标档位数与声明一致');
  for (const icon of artifacts.icons) {
    assert.deepEqual(
      pngSize(icon.buffer),
      { width: icon.size, height: icon.size },
      `${icon.name} 的像素尺寸应为 ${String(icon.size)}`,
    );
  }
  assert.deepEqual(
    artifacts.icons.map((icon) => icon.name),
    LINUX_ICON_SIZES.map((size) => `${String(size)}x${String(size)}.png`),
    'Linux 图标目录须按 electron-builder 约定命名为 NxN.png',
  );
});

test('图标：iconset 的 10 个文件命名与尺寸完整', () => {
  const { iconset } = buildIconArtifacts();

  assert.equal(iconset.length, 10, 'iconset 应为 10 个文件');
  assert.deepEqual(
    iconset.map((entry) => entry.name),
    ICONSET_ENTRIES.map((entry) => entry.name),
    'iconset 文件名须符合 iconutil 约定',
  );
  for (const entry of iconset) {
    assert.deepEqual(
      pngSize(entry.buffer),
      { width: entry.size, height: entry.size },
      `${entry.name} 的像素尺寸应为 ${String(entry.size)}`,
    );
  }
  for (const entry of iconset.filter((item) => item.name.includes('@2x'))) {
    const base = iconset.find((item) => item.name === entry.name.replace('@2x', ''));
    assert.ok(base !== undefined, `${entry.name} 应有对应的 1x 条目`);
    assert.equal(entry.size, base.size * 2, `${entry.name} 应为对应 1x 条目的两倍尺寸`);
  }
});

test('图标：ICO 目录表含七个尺寸档且各档负载尺寸匹配', () => {
  const { ico } = buildIconArtifacts();

  assert.equal(ico.readUInt16LE(0), 0, 'ICO 保留字段为 0');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO 类型为图标');
  assert.equal(ico.readUInt16LE(4), ICO_SIZES.length, 'ICO 档位数与声明一致');
  for (const [index, size] of ICO_SIZES.entries()) {
    const entry = 6 + 16 * index;
    assert.equal(ico[entry], size >= 256 ? 0 : size, '目录表尺寸（256 档记 0）');
    const bytes = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.deepEqual(
      pngSize(ico.subarray(offset, offset + bytes)),
      { width: size, height: size },
      `ICO 第 ${String(index)} 档负载尺寸应为 ${String(size)}`,
    );
  }
});

test('图标：确定性——重复生成逐字节一致', () => {
  const first = buildIconArtifacts();
  const second = buildIconArtifacts();

  assert.equal(sha256(first.ico), sha256(second.ico), 'icon.ico 应可重复生成');
  assert.equal(sha256(first.png), sha256(second.png), 'icon.png 应可重复生成');
  assert.deepEqual(
    first.icons.map((icon) => sha256(icon.buffer)),
    second.icons.map((icon) => sha256(icon.buffer)),
    'Linux 图标应可重复生成',
  );
  assert.deepEqual(
    first.iconset.map((entry) => sha256(entry.buffer)),
    second.iconset.map((entry) => sha256(entry.buffer)),
    'iconset 应可重复生成',
  );
});

test('图标：落盘清单完整，重复写入到不同目录哈希一致', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'sm-icon-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'sm-icon-b-'));

  const listA = writeIconArtifacts(dirA);
  const listB = writeIconArtifacts(dirB);

  assert.equal(listA.length, 2 + LINUX_ICON_SIZES.length + ICONSET_ENTRIES.length, '写入文件数');
  assert.deepEqual(
    listA.map((item) => item.path).sort(),
    listB.map((item) => item.path).sort(),
    '两次写入的文件集合一致',
  );
  assert.deepEqual(
    listA.map((item) => item.sha256),
    listB.map((item) => item.sha256),
    '两次写入的哈希一致（幂等）',
  );
  assert.equal(
    sha256(readFileSync(join(dirA, 'icons', '512x512.png'))),
    listA.find((item) => item.path.endsWith(join('icons', '512x512.png')))?.sha256,
    '磁盘字节与清单哈希一致',
  );
});

test('图标：既有入库产物（icon.ico / icon.png）字节不变', () => {
  const artifacts = buildIconArtifacts();

  assert.equal(
    sha256(artifacts.ico),
    sha256(readFileSync(join(root, 'gui', 'packaging', 'icon.ico'))),
    'icon.ico 应与入库产物逐字节一致（Windows 打包口径不受影响）',
  );
  assert.equal(
    sha256(artifacts.png),
    sha256(readFileSync(join(root, 'gui', 'packaging', 'icon.png'))),
    'icon.png 应与入库产物逐字节一致',
  );
});
