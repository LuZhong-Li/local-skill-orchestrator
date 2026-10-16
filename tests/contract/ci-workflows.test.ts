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

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
}

interface WorkflowMatrix {
  os?: unknown;
  node?: unknown;
  include?: unknown;
  'fail-fast'?: unknown;
}

interface WorkflowJob {
  name?: string;
  uses?: string;
  needs?: unknown;
  if?: string;
  steps?: WorkflowStep[];
  outputs?: Record<string, string>;
  strategy?: { 'fail-fast'?: unknown; matrix?: WorkflowMatrix };
  'timeout-minutes'?: number;
}

interface WorkflowTriggers {
  push?: { branches?: string[]; tags?: string[] };
  pull_request?: { branches?: string[]; types?: string[] };
  workflow_dispatch?: unknown;
  workflow_call?: unknown;
  workflow_run?: unknown;
}

interface WorkflowDoc {
  on: WorkflowTriggers;
  concurrency?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
}

function readWorkflow(name: string): { text: string; doc: WorkflowDoc } {
  const text = readFileSync(join(WORKFLOW_DIR, name), 'utf8');
  return { text, doc: parseYaml(text) as WorkflowDoc };
}

function stepsOf(doc: WorkflowDoc): WorkflowStep[] {
  return Object.values(doc.jobs).flatMap((job) => job.steps ?? []);
}

/** 把 run 块拆成逐条命令（按行、去空白），用于精确比对而不是子串匹配 */
function stepCommandLines(doc: WorkflowDoc): string[] {
  return stepsOf(doc)
    .filter((step) => typeof step.run === 'string')
    .flatMap((step) => String(step.run).split('\n'))
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

test('契约：校验步骤集合只在 verify.yml 定义一处（ci.yml 与 pack.yml 仅消费）', () => {
  const verifyLines = stepCommandLines(readWorkflow('verify.yml').doc);
  for (const command of VERIFY_COMMANDS) {
    assert.ok(verifyLines.includes(command), `verify.yml 应包含校验命令：${command}`);
  }

  for (const name of ['ci.yml', 'pack.yml']) {
    const doc = readWorkflow(name).doc;
    const lines = stepCommandLines(doc);
    for (const command of VERIFY_COMMANDS) {
      assert.equal(lines.includes(command), false, `${name} 不得重复定义校验命令：${command}`);
    }
    assert.ok(
      Object.values(doc.jobs).some((job) => job.uses === './.github/workflows/verify.yml'),
      `${name} 应消费可复用校验工作流`,
    );
  }
});

test('契约：verify.yml 为 workflow_call，且校验步骤名称与顺序与 M1 口径一致', () => {
  const { doc } = readWorkflow('verify.yml');
  assert.deepEqual(Object.keys(doc.on), ['workflow_call'], '只允许被调用触发');

  const verifyJob = doc.jobs['verify'] as WorkflowJob;
  const verifySteps = verifyJob.steps ?? [];
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
    verifyJob.strategy?.matrix?.os,
    ['ubuntu-24.04', 'windows-latest'],
    '矩阵取值不变',
  );
  assert.equal(verifyJob.strategy?.['fail-fast'], false);
  assert.equal(verifyJob['timeout-minutes'], 60);
});

test('契约：verify.yml 的版本声明读取与矩阵同源口径不变', () => {
  const { doc } = readWorkflow('verify.yml');
  const prepare = doc.jobs['prepare'] as WorkflowJob;
  assert.equal(prepare.outputs?.['node_versions'], '${{ steps.nvmrc.outputs.versions }}');
  const nvmrcStep = (prepare.steps ?? []).find((step) => step.id === 'nvmrc');
  assert.ok(nvmrcStep !== undefined, 'prepare 应含读取 .nvmrc 的步骤');
  assert.match(String(nvmrcStep.run), /GITHUB_OUTPUT/);
  assert.match(String(nvmrcStep.run), /\.nvmrc/);
  assert.match(
    String(doc.jobs['verify']?.strategy?.matrix?.node),
    /fromJSON\(needs\.prepare\.outputs\.node_versions\)/,
  );
});

test('契约：ci.yml 触发与并发口径保持不变', () => {
  const { doc } = readWorkflow('ci.yml');
  assert.deepEqual(doc.on.push?.branches, ['main', 'release/**', 'hotfix/**']);
  assert.deepEqual(doc.on.pull_request?.branches, ['main']);
  assert.deepEqual(doc.on.pull_request?.types, ['opened', 'synchronize', 'reopened']);
  assert.equal('workflow_dispatch' in doc.on, true, '保留手工触发入口');
  assert.equal(doc.concurrency?.['cancel-in-progress'], true);
  assert.match(String(doc.concurrency?.group), /github\.ref/);
});

test('契约：pack.yml 触发为 tag v* 与手工触发，且只跑打包不发布', () => {
  const { text, doc } = readWorkflow('pack.yml');
  assert.deepEqual(doc.on.push?.tags, ['v*'], 'tag 触发');
  assert.equal('workflow_dispatch' in doc.on, true, '手工触发');
  assert.equal('pull_request' in doc.on, false, 'push/PR 不触发打包（裁决 3）');
  assert.equal('workflow_run' in doc.on, false, 'tag 场景不用 workflow_run 串联');

  // T2 范围：只产出 artifact；Release 发布留 T3
  assert.equal(text.includes('gh release'), false, 'T2 不含 Release 创建');
  assert.match(String(doc.permissions?.['contents']), /read/, 'T2 只读权限');
});

test('契约：pack.yml 四 leg 矩阵、fail-fast: false、tag 不取消旧运行', () => {
  const { doc } = readWorkflow('pack.yml');
  const pack = doc.jobs['pack'] as WorkflowJob;
  assert.equal(pack.strategy?.['fail-fast'], false, '一个平台失败不掩盖其他平台');

  const include = pack.strategy?.matrix?.include as Array<Record<string, string>>;
  assert.deepEqual(
    include.map((entry) => [entry['leg'], entry['os'], entry['arch'] ?? '']),
    [
      ['windows', 'windows-latest', ''],
      ['linux', 'ubuntu-24.04', 'x64'],
      ['mac-arm64', 'macos-15', 'arm64'],
      ['mac-x64', 'macos-15-intel', 'x64'],
    ],
    '四 leg 的 runner 标签与架构',
  );
  assert.equal(pack.needs, 'verify', '打包依赖打包前校验');
  assert.equal(
    doc.concurrency?.['cancel-in-progress'],
    "${{ github.event_name == 'workflow_dispatch' }}",
  );

  const steps = pack.steps ?? [];
  const macEvidence = steps.find((step) => String(step.name).includes('真机验证（macOS）'));
  assert.ok(macEvidence !== undefined, 'mac leg 应有未签名 / icns 真机证据步骤');
  assert.match(String(macEvidence.run), /assert-unsigned\.mjs/);
  assert.match(
    String(macEvidence.run),
    /::notice/,
    '真机结论须以注解输出（未登录会话也能读到运行结论）',
  );
  const linuxEvidence = steps.find((step) => String(step.name).includes('真机验证（Linux）'));
  assert.ok(linuxEvidence !== undefined, 'linux leg 应有 maintainer 实测步骤');
  assert.match(String(linuxEvidence.run), /check-maintainer\.mjs/);
  assert.match(String(linuxEvidence.run), /--appimage-extract/);
  assert.match(String(linuxEvidence.run), /::notice/);
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
    for (const [jobId, job] of Object.entries(doc.jobs)) {
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
  const steps = (doc.jobs['pack'] as WorkflowJob).steps ?? [];
  const guarded = steps.filter(
    (step) => typeof step.if === 'string' && String(step.if).includes('inputs.platforms'),
  );
  assert.ok(guarded.length >= 4, '打包 / 真机证据 / 上传步骤应带平台过滤');
  const upload = steps.find((step) => String(step.name) === '上传产物');
  assert.ok(upload !== undefined, 'pack 应含上传步骤');
  assert.match(String(upload.if), /inputs\.platforms/, '未选中的 leg 不得上传产物');
});

test('契约：pack.yml 失败路径引用自证诊断（阶段文件与打包器日志），且内核签名有真机断言', () => {
  const { doc } = readWorkflow('pack.yml');
  const steps = (doc.jobs['pack'] as WorkflowJob).steps ?? [];

  const packSteps = steps.filter((step) => String(step.name).startsWith('打包（'));
  assert.equal(packSteps.length, 2, 'Windows 与 macOS/Linux 各一条打包步骤');
  for (const step of packSteps) {
    const run = String(step.run);
    assert.match(run, /pack-debug\.log/, `${step.name} 的失败注解应回落到打包器日志`);
    assert.match(run, /build\/desktop\/pack-debug\.log/, '日志路径应在诊断产物范围内');
  }
  const unixPack = packSteps.find((step) => String(step.name).includes('macOS / Linux'));
  assert.match(String(unixPack?.run), /pack-stage\.txt/, 'macOS/Linux 打包应报出最后阶段');

  const macEvidence = steps.find((step) => String(step.name).includes('真机验证（macOS）'));
  const macRun = String(macEvidence?.run);
  assert.match(macRun, /codesign -dv/, '内核二进制的签名应有真机断言');
  assert.match(macRun, /Contents\/Resources\/kernel/, '断言对象应是包内随分发内核');
  assert.match(macRun, /::error/, '签名无效时必须以错误级注解暴露');
});

test('契约：pack.yml 的 release job 仅在 tag 触发、具备最小写权限且走守卫与发布脚本', () => {
  const { text, doc } = readWorkflow('pack.yml');
  const release = doc.jobs['release'] as WorkflowJob & { permissions?: Record<string, unknown> };

  assert.ok(release !== undefined, 'pack.yml 应有 release job');
  assert.equal(release.if, "startsWith(github.ref, 'refs/tags/v')", '仅 refs/tags/v* 触发发布');
  assert.equal(release.needs, 'pack', '发布依赖四 leg 打包完成');
  assert.match(String(release.permissions?.['contents']), /write/, '发布 job 需要 contents: write');
  assert.match(String(doc.permissions?.['contents']), /read/, '工作流级仍是最小只读');

  const steps = release.steps ?? [];
  const download = steps.find((step) => String(step.uses).includes('download-artifact'));
  assert.ok(download !== undefined, '发布 job 应汇总 leg 产物');
  assert.match(
    String(download.uses),
    /download-artifact@v[89]$/,
    '汇总产物使用面向 Node 24 的主版本（v7 起；v6 仍面向 Node 20 会产生废弃告警）',
  );
  const runs = steps.map((step) => String(step.run ?? '')).join('\n');
  assert.match(runs, /release-guard\.mjs/, '发布前执行版本守卫');
  assert.match(runs, /release-publish\.mjs/, '发布经发布脚本执行');
  assert.match(runs, /--gui-package gui\/package\.json/, '三方比对包含 gui 的版本声明');
  assert.match(runs, /--write-notes RELEASE_NOTES\.md/, 'Release notes 写在发布目录之外');
  assert.equal(
    /--notes release\//.test(runs),
    false,
    'Release notes 不得落在交付目录内（否则归位检查会把它当成非交付物）',
  );
  assert.match(runs, /::error title=发布失败/, '发布失败时以错误级注解暴露原因');
  assert.equal(runs.includes('--dry-run'), false, '正式工作流不得预演');
  assert.equal(text.includes('prerelease'), false, '不打 prerelease 标记');

  // 诊断包命名不得与交付产物混淆（发布汇总按 pack-* 取件）
  assert.match(text, /name: diagnostics-pack-/, '诊断包以 diagnostics- 前缀命名');
});

test('契约：pack.yml 含 Release 资产级冒烟（回下载 + 校验 + 结构与内核闭环 + GUI 尝试）', () => {
  const { doc } = readWorkflow('pack.yml');
  const steps = (doc.jobs['release'] as WorkflowJob).steps ?? [];
  const smoke = steps.find((step) => String(step.name).includes('Release 资产级冒烟'));
  assert.ok(smoke !== undefined, '发布后应有资产级冒烟步骤');
  const run = String(smoke.run);

  assert.match(run, /releases\/download\/\$\{GITHUB_REF_NAME\}/, '从 Release 回下载（验证发布物）');
  assert.match(run, /sha256sum -c SHA256SUMS\.txt/, '用发布物自带的校验清单复算');
  assert.match(run, /--appimage-extract/, 'AppImage 结构校验');
  assert.match(run, /squashfs-root\/resources\/kernel\/skill-manager\.exe/, '定位包内内核');
  assert.match(run, /init --workspace .*scan --workspace .*list --workspace/s, '内核最小闭环');
  assert.match(run, /xvfb-run -a/, 'GUI 冒烟用 xvfb');
  assert.match(run, /::notice/, '结论以注解公开');
  assert.match(run, /降级结论/, 'GUI 跑不通时按降级口径登记，不写「未验证」');
});

test('契约：bench.yml 触发为推送验证路径 + 手工触发，且明确不作性能门禁', () => {
  const { text, doc } = readWorkflow('bench.yml');
  assert.deepEqual(doc.on.push?.branches, ['main'], '推送验证路径（与 ci.yml 同策略）');
  assert.equal('workflow_dispatch' in doc.on, true, '手工触发');
  assert.equal('pull_request' in doc.on, false, '不在 PR 上跑');
  assert.equal('schedule' in doc.on, false, '不做定期（裁决 ③：N=5000 仅人工触发）');
  assert.equal(doc.concurrency?.['cancel-in-progress'], true, '同 ref 取消旧运行');
  assert.match(text, /只记录数据，不做性能门禁/, '定位写明：CI 数值不作门禁');
  assert.equal(text.includes('--runs 1'), true, 'CI 烟测只跑 runs=1');
  assert.equal(
    text.includes('--form both'),
    true,
    '两条线都跑到（源码线 + 内核 SEA）；EX-13 修复后三平台一致',
  );
  assert.equal(
    text.includes('EX-13'),
    true,
    'macOS 曾暂缓 SEA 的历史与解禁依据必须在注释里留痕（缺陷可追溯）',
  );
});

test('契约：bench.yml 三平台矩阵与测量链路健康检查（采样失败即红）', () => {
  const { text, doc } = readWorkflow('bench.yml');
  const smoke = doc.jobs['smoke'] as WorkflowJob;
  const runsOn = (smoke.strategy?.matrix as { include?: Array<Record<string, string>> })?.include;
  assert.deepEqual(
    runsOn?.map((item) => item.runner),
    ['ubuntu-24.04', 'windows-latest', 'macos-15'],
    '三平台矩阵：Linux / Windows / macOS（arm64）',
  );
  assert.equal(smoke.strategy?.['fail-fast'], false, '一个平台失败不影响其余平台出结论');

  const names = (smoke.steps ?? []).map((step) => String(step.name));
  assert.ok(
    names.some((name) => name.includes('构建内核')),
    'SEA 线需要先构建内核（同时验证 mac/Linux 的 SEA 可执行）',
  );
  assert.ok(
    names.some((name) => name.includes('测量链路')),
    '需要一步检查测量链路（采样失败即红）',
  );
  const upload = (smoke.steps ?? []).find((step) =>
    String(step.uses ?? '').includes('upload-artifact'),
  );
  assert.ok(upload !== undefined, '原始数据随 artifact 上传');
  assert.match(String(upload.with?.path), /build\/bench\/report-\*\.json/, '上传测量结果 JSON');
  // 注解通道：未登录也能读结论
  assert.equal(text.includes('annotate.mjs'), true, '结论经注解脚本公开');
});
