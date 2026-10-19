import { makeTempDir } from '../helpers/temp.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KernelBridge } from '../../gui/bridge/commands.ts';
import { isConfirmationRefusal, summarize } from '../../gui/bridge/kernel.ts';

const REPO = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 桥接器以子进程调用真实内核，因此这些用例同时也是界面与内核的联调检查 */
function bridgeFor(workspace: string, entry = ['kernel/entry/cli.ts']): KernelBridge {
  return new KernelBridge({
    command: process.execPath,
    entry,
    workspace,
    cwd: REPO,
  });
}

function workspace(): string {
  const root = makeTempDir('sm-bridge-');
  mkdirSync(join(root, 'skills'), { recursive: true });
  mkdirSync(join(root, 'backups'), { recursive: true });
  return root;
}

function putSkill(root: string, id: string): void {
  const dir = join(root, 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# skill');
  writeFileSync(
    join(dir, 'skill_meta.yaml'),
    [
      `id: ${id}`,
      `name: ${id}`,
      'version: 1.0.0',
      'status: enabled',
      `path: ./skills/${id}`,
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: global',
      `    path: .claude/skills/${id}`,
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: SKILL.md',
      '',
    ].join('\n'),
  );
}

test('G-02 桥接：只读指令直发并解析出结构化结果', async () => {
  const root = workspace();
  const bridge = bridgeFor(root);
  assert.equal((await bridge.init()).ok, true);
  putSkill(root, 'alpha');
  assert.equal((await bridge.scan()).ok, true);

  const listed = await bridge.list();
  assert.equal(listed.ok, true);
  assert.equal(listed.command, 'list');
  const records = (listed.data as { records: Array<{ id: string }> }).records;
  assert.deepEqual(
    records.map((item) => item.id),
    ['alpha'],
  );
  assert.match(summarize(listed), /list：完成/);
});

test('G-02 桥接：写操作先预览再执行，取消时不发写请求', async () => {
  const root = workspace();
  const bridge = bridgeFor(root);
  await bridge.init();

  // 来源放在工作区之外：工作区内的同名目录就是中心库位置，装到自己身上没有意义
  const source = makeTempDir('sm-bridge-src-');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), '# beta');
  writeFileSync(
    join(source, 'skill_meta.yaml'),
    [
      'id: beta',
      'name: beta',
      'status: enabled',
      'path: ./skills/beta',
      'source:',
      '  type: local',
      'targets:',
      '  - target: claude',
      '    scope: global',
      '    path: .claude/skills/beta',
      '    mode: copy',
      '    enabled: true',
      '    file_map:',
      '      SKILL.md: SKILL.md',
      '',
    ].join('\n'),
  );

  const preview = await bridge.preview(['install', source]);
  assert.equal(preview.preview, true, '预览结果带预演标记');
  assert.ok(preview.changes.length > 0, '预览给出将发生的变更');

  // 用户取消：不发写请求，工作区保持原状
  const cancelled = await bridge.invokeWithConfirmation(['install', source], async () => false);
  assert.equal(cancelled.kind, 'cancelled');
  assert.ok(
    !readFileSync(join(root, 'skill_index.yaml'), 'utf8').includes('id: beta'),
    '取消后不得登记',
  );

  // 用户确认：带 --yes 执行
  const executed = await bridge.invokeWithConfirmation(['install', source], async () => true);
  assert.equal(executed.kind, 'result');
  assert.equal(executed.result.ok, true, `安装应成功：${JSON.stringify(executed.result.findings)}`);
  assert.ok(readFileSync(join(root, 'skill_index.yaml'), 'utf8').includes('id: beta'));
});

test('G-02 桥接：未给出确认回调时，内核的确认拒绝被如实回传', async () => {
  const root = workspace();
  const bridge = bridgeFor(root);
  await bridge.init();
  putSkill(root, 'alpha');
  await bridge.scan();

  const refused = await bridge.uninstall('alpha');
  assert.equal(refused.ok, false);
  assert.equal(refused.exit_code, 2);
  assert.equal(isConfirmationRefusal(refused), true, '识别为「需要确认但缺少跳过选项」');
  assert.deepEqual(
    refused.findings.map((item) => item.code),
    ['E-INPUT-001'],
  );
  assert.equal(refused.findings[0]?.target, '--yes');
  assert.ok(
    readFileSync(join(root, 'skill_index.yaml'), 'utf8').includes('id: alpha'),
    '被拒绝时不得改动环境',
  );
});

test('G-02 桥接：十六条指令的具名门面都能拿到结构完整的结果', async () => {
  const root = workspace();
  const bridge = bridgeFor(root);
  const results = [
    await bridge.init(),
    await bridge.configGet(),
    await bridge.scan(),
    await bridge.list(),
    await bridge.inspect('nosuch'),
    await bridge.validate(),
    await bridge.deps('nosuch'),
    await bridge.export('backups/snapshot.yaml'),
    await bridge.update('nosuch'),
    await bridge.enable('nosuch'),
    await bridge.disable('nosuch'),
    await bridge.uninstall('nosuch'),
    await bridge.install(join(root, 'skills', 'nosuch')),
    await bridge.import('backups/snapshot.yaml'),
    await bridge.restore('nosuch'),
    await bridge.restoreList(),
    await bridge.configSet('default_target', 'claude'),
  ];
  // restore 有两条门面方法（恢复与备份列表），因此方法数比指令数多一个
  assert.equal(results.length, 17, '十六条指令各有门面，restore 另有列表方法');
  const commands = [...new Set(results.map((item) => item.command))].sort();
  assert.deepEqual(commands, [
    'config get',
    'config set',
    'deps',
    'disable',
    'enable',
    'export',
    'import',
    'init',
    'inspect',
    'install',
    'list',
    'restore',
    'scan',
    'uninstall',
    'update',
    'validate',
  ]);
  for (const result of results) {
    assert.equal(typeof result.command, 'string');
    assert.ok(Array.isArray(result.findings), `${result.command} 的结果应含问题列表`);
    assert.ok(Array.isArray(result.changes), `${result.command} 的结果应含变更列表`);
    assert.equal(typeof result.exit_code, 'number');
  }
  assert.equal(results[3]?.ok, true, '列表在空工作区可用');
});

test('G-02 桥接：备份管理的恢复流程——读列表、预览、取消不发写请求、确认后执行', async () => {
  const root = workspace();
  const bridge = bridgeFor(root);
  await bridge.init();
  putSkill(root, 'alpha');
  await bridge.scan();

  // 卸载会产出备份载体；这一步带 --yes，模拟界面上已确认过的写操作
  const removed = await bridge.execute(['uninstall', 'alpha']);
  assert.equal(removed.ok, true, `卸载应成功：${JSON.stringify(removed.findings)}`);

  // 读列表：界面只经内核拿数据
  const listed = await bridge.restoreList();
  assert.equal(listed.ok, true);
  const rows = (
    listed.data as { backups: Array<{ id: string; timestamp: string; file_count: number }> }
  ).backups;
  assert.equal(rows.length, 1);
  const backup = rows[0]!;
  assert.equal(backup.id, 'alpha');
  assert.equal(backup.file_count, 2);

  // 破坏现场，确认恢复确实由备份重建内容
  rmSync(join(root, 'skills', 'alpha'), { recursive: true, force: true });
  assert.ok(!existsSync(join(root, 'skills', 'alpha')), '前置：中心库原件已不在');

  const preview = await bridge.preview(['restore', 'alpha', '--timestamp', backup.timestamp]);
  assert.equal(preview.preview, true, '预览带预演标记');
  assert.ok(preview.changes.length > 0, '预览给出将发生的变更');
  assert.equal((preview.data as { library_exists: boolean }).library_exists, false);
  assert.ok(
    ((preview.data as { notes?: string[] }).notes ?? []).length > 0,
    '预览载荷带覆盖与结论提示，供确认弹窗如实展示',
  );

  // 取消：不发写请求
  const cancelled = await bridge.invokeWithConfirmation(['restore', 'alpha'], async () => false);
  assert.equal(cancelled.kind, 'cancelled');
  assert.ok(!existsSync(join(root, 'skills', 'alpha')), '取消后不得写回原件');

  // 确认：带 --yes 执行
  const executed = await bridge.invokeWithConfirmation(['restore', 'alpha'], async () => true);
  assert.equal(executed.kind, 'result');
  assert.equal(executed.result.ok, true, `恢复应成功：${JSON.stringify(executed.result.findings)}`);
  assert.ok(existsSync(join(root, 'skills', 'alpha', 'SKILL.md')), '原件按备份重建');

  // 没有备份的标识：问题码如实回传（界面据此展示可读错误）
  const degraded = await bridge.restoreList('nosuch');
  assert.equal(degraded.ok, true);
  assert.equal((degraded.data as { total: number }).total, 0);
  const missing = await bridge.run(['restore', 'nosuch', '--yes']);
  assert.equal(missing.ok, false);
  assert.deepEqual(
    missing.findings.map((item) => item.code),
    ['E-BAK-003'],
  );

  // 非 TTY 约束在桥接层同样成立：不带 --yes 又无确认回调时，内核拒绝并回传参数类问题
  const refused = await bridge.restore('alpha');
  assert.equal(refused.ok, false);
  assert.equal(isConfirmationRefusal(refused), true, '识别为「需要确认但缺少跳过选项」');
});

test('G-02 桥接：通道失败映射为宿主通道问题码，不吞诊断信息', async () => {
  const root = workspace();
  const bridge = bridgeFor(root, ['kernel/entry/nosuch-entry.ts']);
  const result = await bridge.run(['list']);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.findings.map((item) => item.code),
    ['E-CHANNEL-001'],
  );
  assert.match(String(result.findings[0]?.message), /未返回结构化结果|无法启动内核子进程/);
  assert.match(String(result.findings[0]?.remedy), /内核|环境/);
});

test('G-02 桥接：内核的业务失败按结果封装返回，不当成通道异常', async () => {
  const root = makeTempDir('sm-bridge-empty-');
  const bridge = bridgeFor(root);
  const result = await bridge.list();
  assert.equal(result.ok, true, '未初始化时 list 返回引导性结果');
  assert.equal(
    (result.data as { initialized: boolean }).initialized,
    false,
    '界面据此显示空工作区引导',
  );
  const inspect = await bridge.inspect('alpha');
  assert.equal(inspect.ok, false);
  assert.equal(inspect.exit_code, 1, '环境类问题按通用派生返回 1');
  assert.ok(inspect.findings.some((item) => item.code.startsWith('E-ENV-')));
});
