#!/usr/bin/env node
/**
 * 生成应用图标。
 *
 * 图标是程序化绘制的，不引入图形库：形状用带符号距离场加解析抗锯齿，PNG 与 ICO
 * 都用最小编码器直接写出。这样图标的唯一来源就是本脚本，任何尺寸都能精确重生成。
 *
 * 产物：gui/packaging/icon.ico（打包用，含 16 至 256 的多档尺寸）与 icon.png（窗口与文档用）。
 * 配色沿用界面规范的香槟金强调色。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'gui', 'packaging');

/** 界面规范里的强调色与其加深色 */
const ACCENT = [0xd7, 0xb9, 0x79];
const ACCENT_DEEP = [0xc2, 0xa2, 0x5f];
const MARK = [0x3a, 0x2f, 0x14];

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** 圆角矩形的带符号距离：负数在形状内 */
function roundedRectDistance(px, py, cx, cy, halfWidth, halfHeight, radius) {
  const dx = Math.abs(px - cx) - (halfWidth - radius);
  const dy = Math.abs(py - cy) - (halfHeight - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** 由距离场得到覆盖率，天然带一像素抗锯齿 */
function coverage(distance) {
  return clamp01(0.5 - distance);
}

function blend(base, top, alpha) {
  return [
    base[0] + (top[0] - base[0]) * alpha,
    base[1] + (top[1] - base[1]) * alpha,
    base[2] + (top[2] - base[2]) * alpha,
  ];
}

/**
 * 绘制一帧：尺寸无关，全部按比例计算。
 * 构图：香槟金圆角方块底，内嵌三条长短递减的圆角横条，读作「被统一管理的一组条目」。
 */
function render(size) {
  const pixels = new Uint8Array(size * size * 4);
  const unit = size / 256;
  const tile = {
    cx: size / 2,
    cy: size / 2,
    half: 108 * unit,
    radius: 52 * unit,
  };
  const bars = [
    { width: 116 * unit, y: 88 * unit, alpha: 1 },
    { width: 92 * unit, y: 128 * unit, alpha: 0.82 },
    { width: 68 * unit, y: 168 * unit, alpha: 0.64 },
  ];
  const barHalfHeight = 11 * unit;
  const barRadius = barHalfHeight;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      const tileAlpha = coverage(
        roundedRectDistance(px, py, tile.cx, tile.cy, tile.half, tile.half, tile.radius),
      );
      if (tileAlpha <= 0) continue;

      // 底色：自上而下的轻微渐变，避免大色块过于平板
      const ratio = clamp01(y / size);
      let color = [
        ACCENT[0] + (ACCENT_DEEP[0] - ACCENT[0]) * ratio,
        ACCENT[1] + (ACCENT_DEEP[1] - ACCENT[1]) * ratio,
        ACCENT[2] + (ACCENT_DEEP[2] - ACCENT[2]) * ratio,
      ];

      for (const bar of bars) {
        const barAlpha =
          coverage(
            roundedRectDistance(
              px,
              py,
              tile.cx,
              tile.cy + bar.y - 128 * unit,
              bar.width / 2,
              barHalfHeight,
              barRadius,
            ),
          ) * bar.alpha;
        if (barAlpha > 0) color = blend(color, MARK, barAlpha);
      }

      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(color[0]);
      pixels[offset + 1] = Math.round(color[1]);
      pixels[offset + 2] = Math.round(color[2]);
      pixels[offset + 3] = Math.round(tileAlpha * 255);
    }
  }
  return pixels;
}

/** 把像素按 PNG 规范编码：IHDR、IDAT、IEND */
function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // 每行过滤器为 none
    pixels.subarray(y * size * 4, (y + 1) * size * 4).forEach((value, index) => {
      raw[y * (size * 4 + 1) + 1 + index] = value;
    });
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk(
      'IHDR',
      Buffer.concat([
        uint32(size),
        uint32(size),
        Buffer.from([8, 6, 0, 0, 0]), // 8 位每通道、RGBA、无隔行
      ]),
    ),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function chunk(type, data) {
  const head = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  return Buffer.concat([uint32(data.length), head, uint32(crc32(head))]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** 多尺寸 ICO：目录表 + 各尺寸 PNG 负载，Windows Vista 起支持 PNG 负载 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留
  header.writeUInt16LE(1, 2); // 类型：图标
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const entry = 16 * index;
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0; // 调色板数
    directory[entry + 3] = 0; // 保留
    directory.writeUInt16LE(1, entry + 4); // 颜色平面
    directory.writeUInt16LE(32, entry + 6); // 位深
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

mkdirSync(OUT_DIR, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((size) => ({ size, png: encodePng(size, render(size)) }));

writeFileSync(join(OUT_DIR, 'icon.ico'), encodeIco(images));
writeFileSync(join(OUT_DIR, 'icon.png'), images[images.length - 1].png);
console.log(`图标已生成：packaging/icon.ico（${sizes.join('、')}）与 packaging/icon.png`);
