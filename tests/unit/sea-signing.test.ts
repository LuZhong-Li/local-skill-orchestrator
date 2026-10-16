import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODESIGN_ACTIONS,
  adHocSignMac,
  codesignArgs,
  removeMacSignature,
  runCodesignAction,
} from '../../scripts/sea-signing.mjs';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const EXE = '/tmp/skill-manager.exe';

test('SEA 签名：codesign 参数拼装（remove / sign / 未知动作）', () => {
  assert.deepEqual(codesignArgs('remove', EXE), ['--remove-signature', EXE]);
  assert.deepEqual(codesignArgs('sign', EXE), ['--sign', '-', EXE], 'ad-hoc 签名用 `-` 身份');
  assert.deepEqual(CODESIGN_ACTIONS, ['remove', 'sign'], '动作集合与调用顺序一致');
  assert.throws(() => codesignArgs('verify', EXE), /未知的 codesign 动作/);
});

test('SEA 签名：非 macOS 不调用外部命令', () => {
  let calls = 0;
  const run = () => {
    calls += 1;
    return { status: 0, stdout: '', stderr: '' };
  };

  for (const platform of ['linux', 'win32'] as const) {
    const removed = removeMacSignature({ executable: EXE, platform, run });
    const signed = adHocSignMac({ executable: EXE, platform, run });
    assert.equal(removed.applied, false);
    assert.equal(signed.applied, false);
  }
  assert.equal(calls, 0, '非 macOS 平台不得调用 codesign');
});

test('SEA 签名：macOS 上按参数调用（remove 与 sign 各一次）', () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    return { status: 0, stdout: '', stderr: '' };
  };

  const removed = removeMacSignature({ executable: EXE, platform: 'darwin', run });
  const signed = adHocSignMac({ executable: EXE, platform: 'darwin', run });

  assert.deepEqual(calls, [
    { command: 'codesign', args: ['--remove-signature', EXE] },
    { command: 'codesign', args: ['--sign', '-', EXE] },
  ]);
  assert.equal(removed.applied, true);
  assert.equal(signed.applied, true);
});

test('SEA 签名：三类失败按既有口径明确报错', () => {
  const base = { executable: EXE, platform: 'darwin' as const };

  // 一、非零退出：带退出码与 stderr
  assert.throws(
    () =>
      runCodesignAction({ ...base, action: 'sign', run: () => ({ status: 1, stderr: 'boom' }) }),
    /退出码 1：boom/,
  );
  // 二、非零退出但无输出：明确写「(无输出)」，不静默
  assert.throws(
    () =>
      runCodesignAction({ ...base, action: 'remove', run: () => ({ status: 1, stderr: '  ' }) }),
    /退出码 1：\(无输出\)/,
  );
  // 三、命令无法启动（error）与退出码缺失（被中断）：都判失败
  assert.throws(
    () =>
      runCodesignAction({
        ...base,
        action: 'sign',
        run: () => ({ error: new Error('spawn codesign ENOENT'), status: null }),
      }),
    /调用失败：spawn codesign ENOENT/,
  );
  assert.throws(
    () => runCodesignAction({ ...base, action: 'sign', run: () => ({ status: null, stderr: '' }) }),
    /退出码 \(未知\)/,
  );
});

test('SEA 签名：构建脚本按「remove → 注入 → sign」的顺序调用（源码顺序断言）', () => {
  const source = readFileSync(join(root, 'scripts', 'build-kernel.mjs'), 'utf8');
  const removeAt = source.indexOf('removeMacSignature(');
  const injectAt = source.indexOf("'NODE_SEA_BLOB'");
  const signAt = source.indexOf('adHocSignMac(');

  assert.ok(removeAt > 0, '构建脚本应调用 removeMacSignature');
  assert.ok(injectAt > 0, '构建脚本应执行 postject 注入');
  assert.ok(signAt > 0, '构建脚本应调用 adHocSignMac');
  assert.ok(removeAt < injectAt, '移除签名必须在注入之前');
  assert.ok(injectAt < signAt, 'ad-hoc 重签必须在注入之后');
});
