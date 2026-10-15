#!/usr/bin/env node
/**
 * 构建期强制检查：指令清单与结果结构未被破坏。
 *
 * 依据：架构文档 6.4 节「构建期强制检查」第 1 条与第 2 条。
 * 检查对象是 docs/specification 下的契约文档，而非源码；
 * 任何使指令清单或结果封装结构偏离基线契约的改动都会在此处失败。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 指令契约：十六条指令的规范名 */
const EXPECTED_COMMANDS = [
  'init',
  'config get',
  'config set',
  'scan',
  'list',
  'inspect',
  'install',
  'uninstall',
  'enable',
  'disable',
  'update',
  'validate',
  'deps',
  'export',
  'import',
  'restore',
];

/** 结果封装的必填顶层字段 */
const EXPECTED_ENVELOPE = [
  'ok',
  'command',
  'id',
  'findings',
  'changes',
  'exit_code',
  'data',
  'request_id',
];

/** 退出码取值 */
const EXPECTED_EXIT_CODES = ['0', '1', '2', '3', '4', '5', '6'];

const failures = [];

function read(relativePath) {
  try {
    return readFileSync(join(ROOT, relativePath), 'utf8');
  } catch (error) {
    failures.push(`无法读取 ${relativePath}：${error.message}`);
    return '';
  }
}

function section(text, startHeading, endHeading) {
  const start = text.indexOf(startHeading);
  if (start === -1) return '';
  const end = endHeading ? text.indexOf(endHeading, start + startHeading.length) : -1;
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

function tableFirstColumn(block, pattern) {
  const found = new Set();
  for (const line of block.split('\n')) {
    const match = pattern.exec(line);
    if (match) found.add(match[1].trim());
  }
  return found;
}

function diff(label, expected, actual) {
  const missing = expected.filter((item) => !actual.has(item));
  const extra = [...actual].filter((item) => !expected.includes(item));
  if (missing.length) failures.push(`${label} 缺少：${missing.join('、')}`);
  if (extra.length) failures.push(`${label} 多出：${extra.join('、')}`);
}

// 1. 指令清单
const cliContract = read('docs/specification/cli-contract.md');
const commandTable = section(cliContract, '## 3. 指令总表', '## 4.');
if (!commandTable) {
  failures.push('未能在指令契约规范中定位「指令总表」一节');
} else {
  const commands = tableFirstColumn(commandTable, /^\|\s*\d+\s*\|\s*`([^`]+)`\s*\|/);
  diff('指令清单', EXPECTED_COMMANDS, commands);
  if (commands.size !== EXPECTED_COMMANDS.length) {
    failures.push(`指令数量期望 ${EXPECTED_COMMANDS.length} 条，实际 ${commands.size} 条`);
  }
}

// 2. 结果封装结构
const resultContract = read('docs/specification/result-and-exit-codes.md');
const envelope = section(resultContract, '### 2.1 顶层字段', '### 2.2');
if (!envelope) {
  failures.push('未能在结果与退出码规范中定位「顶层字段」一节');
} else {
  const fields = tableFirstColumn(envelope, /^\|\s*`([^`]+)`\s*\|/);
  diff('结果封装顶层字段', EXPECTED_ENVELOPE, fields);
}

// 3. 退出码
const exitCodes = section(resultContract, '### 5.1 取值定义', '### 5.2');
if (!exitCodes) {
  failures.push('未能在结果与退出码规范中定位「取值定义」一节');
} else {
  const codes = tableFirstColumn(exitCodes, /^\|\s*`(\d+)`\s*\|/);
  diff('退出码取值', EXPECTED_EXIT_CODES, codes);
}

// 4. 需求侧的指令清单与契约一致
const requirements = read('docs/requirements.md');
const requirementCommands = tableFirstColumn(
  section(requirements, '### 5.2 指令清单', '### 5.3'),
  /^\|\s*\d+\s*\|\s*`skill-manager ([^`<]+)/,
);
if (requirementCommands.size) {
  // 需求文档的指令列写作 `skill-manager <名称>` 或 `skill-manager validate [路径或名称]`，
  // 这里只取指令名，剥掉位置参数占位符。
  const normalized = new Set(
    [...requirementCommands].map((item) => item.replace(/\s*[[<].*$/, '').trim()),
  );
  diff('需求文档与契约的指令清单', EXPECTED_COMMANDS, normalized);
}

// 输出
if (failures.length) {
  console.error('契约校验失败：');
  for (const item of failures) console.error(`  - ${item}`);
  console.error('\n契约已偏离基线。若本次改动是有意的，需先修订对应契约文档与变更记录。');
  process.exit(1);
}

console.log(
  `契约校验通过：指令 ${EXPECTED_COMMANDS.length} 条、结果封装字段 ${EXPECTED_ENVELOPE.length} 项、退出码 ${EXPECTED_EXIT_CODES.length} 个。`,
);
