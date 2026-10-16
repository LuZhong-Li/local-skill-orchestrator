import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const root = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const WORKFLOW_DIR = join(root, '.github', 'workflows');

/** 校验步骤集合：这些命令只允许出现在 verify.yml（M2-R5 唯一实现） */
const VERIFY_COMMANDS = [
  'npm run check',
  'npm run typecheck',
  'npm run lint',
  'npm run format:check',
  'npm test',
  'npm run build',
  'npm run smoke:kernel',
];

function readWorkflow(name: string): { text: string; doc: Record<string, any> } {
  const text = readFileSync(join(WORKFLOW_DIR, name), 'utf8');
  return { text, doc: parseYaml(text) as Record<string, any> };
}

function stepRuns(doc: Record<string, any>): string[] {
  const runs: string[] = [];
  for (const job of Object.values(doc.jobs ?? {}) as Array<Record<string, any>>) {
    for (const step of (job.steps ?? []) as Array<Record<string, any>>) {
      if (typeof step.run === 'string') runs.push(step.run);
    }
  }
  return runs;
}

/** 把 run 块拆成逐条命令（按行、去空白），用于精确比对而不是子串匹配 */
function stepCommandLines(doc: Record<string, any>): string[] {
  return stepRuns(doc)
    .flatMap((run) => run.split('\n'))
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

test('契约：校验步骤集合只在 verify.yml 定义一处（ci.yml 与 pack.yml 仅消费）', () => {
  const verify = readWorkflow('verify.yml');
  const ci = readWorkflow('ci.yml');
  const pack = readWorkflow('pack.yml');

  const verifyLines = stepCommandLines(verify.doc);
  for (const command of VERIFY_COMMANDS) {
    assert.ok(verifyLines.includes(command), `verify.yml 应包含校验命令：${command}`);
  }

  for (const [name, workflow] of [
    ['ci.yml', ci],
    ['pack.yml', pack],
  ] as const) {
    const lines = stepCommandLines(workflow.doc);
    for (const command of VERIFY_COMMANDS) {
      assert.equal(lines.includes(command), false, `${name} 不得重复定义校验命令：${command}`);
    }
    const jobs = Object.values(workflow.doc.jobs ?? {}) as Array<Record<string, any>>;
    assert.ok(
      jobs.some((job) => job.uses === './.github/workflows/verify.yml'),
      `${name} 应消费可复用校验工作流`,
    );
  }
});

test('契约：verify.yml 为 workflow_call，且校验步骤名称与顺序与 M1 口径一致', () => {
  const { doc } = readWorkflow('verify.yml');
  assert.deepEqual(Object.keys(doc.on), ['workflow_call'], '只允许被调用触发');

  const verifySteps = (doc.jobs.verify.steps ?? []) as Array<Record<string, any>>;
  assert.deepEqual(
    verifySteps
      .filter((step) => typeof step.run === 'string')
      .map((step) => String(step.run).trim()),
    [
      'node scripts/check-node-version.mjs --expect ${{ matrix.node }}',
      'npm ci',
      'npm run check',
      'npm run typecheck',
      'npm run lint',
      'npm run format:check',
      'npm test',
      'npm run build',
      'npm run smoke:kernel',
    ],
    '校验命令与顺序须与抽取前逐条一致',
  );
  assert.deepEqual(
    verifySteps.map((step) => String(step.name)),
    [
      '检出',
      '安装 Node ${{ matrix.node }}',
      '版本声明一致性守卫（矩阵取值与 .nvmrc）',
      '一、安装依赖（按锁文件）',
      '二、契约校验与分层校验',
      '三、类型检查',
      '四、代码规范',
      '五、格式检查（只读）',
      '六、测试（单元 / 契约 / 端到端，含用例数核对）',
      '七、构建（内核独立可执行文件 + 桌面外壳构建）',
      '八、缩减冒烟（内核侧，不启动 Electron）',
      '上传构建产物',
      '失败时的诊断产物',
    ],
    '步骤名称与顺序须与抽取前逐条一致（行为不变的可核对证据）',
  );
  assert.deepEqual(
    doc.jobs.verify.strategy.matrix.os,
    ['ubuntu-24.04', 'windows-latest'],
    '矩阵取值不变',
  );
  assert.equal(doc.jobs.verify.strategy['fail-fast'], false);
  assert.equal(doc.jobs.verify['timeout-minutes'], 60);
});

test('契约：verify.yml 的版本声明读取与矩阵同源口径不变', () => {
  const { doc } = readWorkflow('verify.yml');
  const prepare = doc.jobs.prepare;
  assert.equal(prepare.outputs.node_versions, '${{ steps.nvmrc.outputs.versions }}');
  const nvmrcStep = (prepare.steps ?? []).find((step: Record<string, any>) => step.id === 'nvmrc');
  assert.ok(nvmrcStep !== undefined, 'prepare 应含读取 .nvmrc 的步骤');
  assert.match(String(nvmrcStep.run), /GITHUB_OUTPUT/);
  assert.match(String(nvmrcStep.run), /\.nvmrc/);
  assert.match(
    String(doc.jobs.verify.strategy.matrix.node),
    /fromJSON\(needs\.prepare\.outputs\.node_versions\)/,
  );
});

test('契约：ci.yml 触发与并发口径保持不变', () => {
  const { doc } = readWorkflow('ci.yml');
  assert.deepEqual(doc.on.push.branches, ['main', 'release/**', 'hotfix/**']);
  assert.deepEqual(doc.on.pull_request.branches, ['main']);
  assert.deepEqual(doc.on.pull_request.types, ['opened', 'synchronize', 'reopened']);
  assert.equal('workflow_dispatch' in doc.on, true, '保留手工触发入口');
  assert.equal(doc.concurrency['cancel-in-progress'], true);
  assert.match(String(doc.concurrency.group), /github\.ref/);
});

test('契约：pack.yml 触发为 tag v* 与手工触发，且只跑打包不发布', () => {
  const { text, doc } = readWorkflow('pack.yml');
  assert.deepEqual(doc.on.push.tags, ['v*'], 'tag 触发');
  assert.equal('workflow_dispatch' in doc.on, true, '手工触发');
  assert.equal('pull_request' in doc.on, false, 'push/PR 不触发打包（裁决 3）');
  assert.equal('workflow_run' in doc.on, false, 'tag 场景不用 workflow_run 串联');

  // T2 范围：只产出 artifact；Release 发布留 T3
  assert.equal(text.includes('gh release'), false, 'T2 不含 Release 创建');
  assert.equal(text.includes('content write'), false);
  assert.match(String(doc.permissions.contents), /read/, 'T2 只读权限');
});

test('契约：pack.yml 四 leg 矩阵与 fail-fast: false、tag 不取消旧运行', () => {
  const { doc } = readWorkflow('pack.yml');
  const pack = doc.jobs.pack;
  assert.equal(pack.strategy['fail-fast'], false, '一个平台失败不掩盖其他平台');
  assert.deepEqual(
    pack.strategy.matrix.include.map((entry: Record<string, string>) => [
      entry.leg,
      entry.os,
      entry.arch ?? '',
    ]),
    [
      ['windows', 'windows-latest', ''],
      ['linux', 'ubuntu-24.04', 'x64'],
      ['mac-arm64', 'macos-15', 'arm64'],
      ['mac-x64', 'macos-15-intel', 'x64'],
    ],
    '四 leg 的 runner 标签与架构',
  );
  assert.deepEqual(pack.needs, 'verify', '打包依赖打包前校验');
  assert.equal(
    doc.concurrency['cancel-in-progress'],
    "${{ github.event_name == 'workflow_dispatch' }}",
  );

  const steps = (pack.steps ?? []) as Array<Record<string, any>>;
  const macEvidence = steps.find((step) => String(step.name).includes('真机验证（macOS）'));
  assert.ok(macEvidence !== undefined, 'mac leg 应有未签名/icns 真机证据步骤');
  assert.match(String(macEvidence.run), /assert-unsigned\.mjs/);
  const linuxEvidence = steps.find((step) => String(step.name).includes('真机验证（Linux）'));
  assert.ok(linuxEvidence !== undefined, 'linux leg 应有 maintainer 实测步骤');
  assert.match(String(linuxEvidence.run), /check-maintainer\.mjs/);
  assert.match(String(linuxEvidence.run), /--appimage-extract/);
});

test('契约：三个工作流的官方动作主版本同口径', () => {
  for (const name of ['verify.yml', 'pack.yml']) {
    const { text } = readWorkflow(name);
    for (const action of [
      'actions/checkout@v5',
      'actions/setup-node@v5',
      'actions/upload-artifact@v6',
    ]) {
      assert.ok(text.includes(action), `${name} 应使用 ${action}`);
    }
  }
});

test('契约：job 级 if 不得引用 matrix（GitHub 工作流校验规则）', () => {
  for (const name of ['ci.yml', 'verify.yml', 'pack.yml']) {
    const { doc } = readWorkflow(name);
    for (const [jobId, job] of Object.entries(doc.jobs ?? {}) as Array<
      [string, Record<string, any>]
    >) {
      if (typeof job.if === 'string') {
        assert.equal(
          /matrix\./.test(job.if),
          false,
          `${name} 的 job ${jobId} 在 job 级 if 中引用了 matrix：GitHub 会判为 Invalid workflow file`,
        );
      }
    }
  }
});

test('契约：pack.yml 的 platforms 输入在步骤级过滤（打包、证据与上传步骤均受控）', () => {
  const { doc } = readWorkflow('pack.yml');
  const steps = (doc.jobs.pack.steps ?? []) as Array<Record<string, any>>;
  const guarded = steps.filter(
    (step) => typeof step.if === 'string' && String(step.if).includes('inputs.platforms'),
  );
  assert.ok(guarded.length >= 4, '打包 / 真机证据 / 上传步骤应带平台过滤');
  const upload = steps.find((step) => String(step.name) === '上传产物');
  assert.ok(upload !== undefined, 'pack 应含上传步骤');
  assert.match(String(upload.if), /inputs\.platforms/, '未选中的 leg 不得上传产物');
});
