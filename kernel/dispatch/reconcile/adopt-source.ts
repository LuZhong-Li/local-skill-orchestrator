/** T2 adopt 的来源读取、元数据合成与中心库暂存；不提交索引/账本。 */
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODES,
  type Finding,
  type ReconcilePlanItem,
  type ReconcileSelection,
} from '@skill-manager/contract';
import { computeChecksum, computeLandingChecksum } from '../../core/integrity/index.ts';
import { readSkillFrontmatter } from '../../core/inventory/discover.ts';
import { safeDigests } from '../../core/lifecycle/shared.ts';
import { copyPathOf } from '../../core/metadata/targets.ts';
import { resolveTargetById, type ResolvedTarget } from '../../core/targets/resolver/index.ts';
import { ID_PATTERN } from '../../core/metadata/constants.ts';
import type { SkillIndex } from '../../core/metadata/types.ts';
import { validateMetaRecord } from '../../core/metadata/validate.ts';
import type { WorkspaceLayout } from '../../store/workspace/index.ts';
import { atomicWriteFile, renameWithRetry } from '../../store/atomic/index.ts';
import { copyTree, removeTree } from '../../store/library-fs/index.ts';
import { stringifyYaml } from '../../store/yaml/index.ts';
import { normalizeAdoptFrontmatter, type NormalizedAdoptFrontmatter } from './adopt-frontmatter.ts';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TARGET_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_MARKER = 'SKILL.md';
const DISABLED_MARKER = 'SKILL.md.disabled';

export interface AdoptInput {
  item: ReconcilePlanItem;
  layout: WorkspaceLayout;
  index: SkillIndex;
  selection: ReconcileSelection;
  now: string;
}

export interface AdoptIdentity {
  hostDir: string;
  skillId: string;
  description: string;
  version?: string;
  author?: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  triggerKeywords?: string[];
  status: 'enabled' | 'disabled';
  targetId: string;
  target: ResolvedTarget;
  hostDigest: string;
  findings: Finding[];
}

interface FrontmatterIdentity {
  skillId: string;
  description: string;
  version?: string;
  author?: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
  triggerKeywords?: string[];
  status: 'enabled' | 'disabled';
  findings: Finding[];
}

export interface PreparedAdopt extends AdoptIdentity {
  staging: string;
  libraryDir: string;
  checksum: string;
  digests?: Record<string, string>;
  meta: Record<string, unknown>;
}

export class AdoptError extends Error {
  readonly findings: Finding[];

  constructor(findings: Finding[]) {
    super(findings[0]?.message ?? 'adopt failed');
    this.findings = findings;
  }
}

function invalid(code: Finding['code'], target: string, message: string, remedy: string): Finding {
  return { code, severity: 'error', source: 'reconcile', target, message, remedy };
}

function markerPath(item: ReconcilePlanItem): string {
  const name = item.visibility === 'disabled' ? DISABLED_MARKER : SKILL_MARKER;
  return join(item.target_path, name);
}

function validSkillId(value: string | undefined): value is string {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.length <= 64 && ID_PATTERN.test(trimmed);
}

function versionOf(value: string | undefined): string | undefined {
  return value !== undefined && VERSION_PATTERN.test(value) ? value : undefined;
}

function assignDefined<T extends object>(target: T, values: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  }
  return target;
}

function assertAdoptableShape(item: ReconcilePlanItem): void {
  if (item.format !== 'skill') {
    throw new AdoptError([
      invalid(
        CODES.RECONCILE_ACTION_UNSUPPORTED,
        item.target_path,
        'adopt 只接受含 SKILL.md 的技能副本',
        '规则文件请保留原形态，或先由对应宿主提供技能副本',
      ),
    ]);
  }
  const hostId = item.host_ids[0] ?? '';
  if (hostId.startsWith('x-')) {
    throw new AdoptError([
      invalid(
        CODES.RECONCILE_ACTION_UNSUPPORTED,
        hostId,
        '插件 x- 宿主不支持 adopt',
        '插件技能源归插件包，不应导入工作区中心库',
      ),
    ]);
  }
  if (!existsSync(item.target_path) || !statSync(item.target_path).isDirectory()) {
    throw new AdoptError([
      invalid(
        CODES.PATH_INVALID,
        item.target_path,
        'adopt 的宿主副本目录不存在',
        '重新盘点后再选择副本',
      ),
    ]);
  }
}

function requiredIdentityOf(
  normalized: NormalizedAdoptFrontmatter,
  marker: string,
): { skillId: string; description: string } {
  const name = normalized.skillId;
  if (!validSkillId(name)) {
    throw new AdoptError([
      invalid(
        CODES.ID_INVALID,
        marker,
        'adopt 需要 frontmatter 中合法的 name 作为 Skill 标识',
        '先修复 name（全小写短横线）或使用 clean/repair',
      ),
    ]);
  }
  const description = normalized.description;
  if (description === undefined) {
    throw new AdoptError([
      invalid(
        CODES.FIELD_REQUIRED,
        marker,
        'adopt 需要 frontmatter 中非空的 description',
        '先补齐 description 或使用 clean/repair',
      ),
    ]);
  }
  return { skillId: name.trim(), description };
}

function frontmatterIdentity(item: ReconcilePlanItem): FrontmatterIdentity {
  const marker = markerPath(item);
  const front = readSkillFrontmatter(marker);
  if (front.raw === null) {
    throw new AdoptError([
      invalid(
        CODES.YAML_INVALID,
        marker,
        `无法读取有效的 SKILL.md frontmatter：${front.reason ?? 'unknown'}`,
        '先修复 frontmatter 或使用 clean/repair 处理损坏副本',
      ),
    ]);
  }
  const normalized = normalizeAdoptFrontmatter(front.raw, marker);
  const required = requiredIdentityOf(normalized, marker);
  const version = versionOf(normalized.version);
  return assignDefined<FrontmatterIdentity>(
    {
      ...required,
      status: item.visibility === 'disabled' ? 'disabled' : 'enabled',
      findings: normalized.findings,
    },
    {
      version,
      author: normalized.author,
      license: normalized.license,
      compatibility: normalized.compatibility,
      allowedTools: normalized.allowedTools,
      metadata: normalized.metadata,
      extensions: normalized.extensions,
      triggerKeywords: normalized.triggerKeywords,
    },
  );
}

function targetIdentity(input: {
  layout: WorkspaceLayout;
  index: SkillIndex;
  selection: ReconcileSelection;
  skillId: string;
  status: 'enabled' | 'disabled';
}): { targetId: string; target: ResolvedTarget } {
  const { layout, index, selection, skillId, status } = input;
  const configured = index.config.default_target;
  const targetId =
    selection.target ??
    (typeof configured === 'string' && configured !== '' ? configured : 'claude');
  if (!TARGET_PATTERN.test(targetId)) {
    throw new AdoptError([
      invalid(
        CODES.INPUT_INVALID_ARG,
        '--target',
        `工作区目标标识不合法：${targetId}`,
        '请使用小写字母、数字与短横线组成的目标标识',
      ),
    ]);
  }
  const target = resolveTargetById(layout.root, targetId, skillId, 'global', status === 'enabled');
  assertTargetUsable(targetId, skillId, target.absolutePath);
  return { targetId, target };
}

function assertTargetUsable(targetId: string, skillId: string, targetPath: string): void {
  if (!existsSync(targetPath)) return;
  if (!statSync(targetPath).isDirectory()) {
    throw new AdoptError([
      invalid(
        CODES.CONFLICT_OCCUPIED,
        targetPath,
        `工作区目标路径已被占用：${targetId}`,
        '请用 --target 选择其他工作区目标',
      ),
    ]);
  }
  const visible = join(targetPath, SKILL_MARKER);
  const disabled = join(targetPath, DISABLED_MARKER);
  const front = readSkillFrontmatter(existsSync(visible) ? visible : disabled);
  const name = front.raw?.['name'];
  if (typeof name !== 'string' || name.trim() !== skillId) {
    throw new AdoptError([
      invalid(
        CODES.CONFLICT_OCCUPIED,
        targetPath,
        `工作区目标 ${targetId} 已存在其他 Skill`,
        '请用 --target 选择空闲的工作区目标',
      ),
    ]);
  }
}

function assertLibraryAdoptable(
  layout: WorkspaceLayout,
  index: SkillIndex,
  skillId: string,
  hostDigest: string,
): void {
  const libraryDir = join(layout.skillsDir, skillId);
  const record = index.skills.find((item) => item.id === skillId);
  if (!existsSync(libraryDir)) {
    if (record === undefined) return;
    throw new AdoptError([
      invalid(
        CODES.ENV_INCOMPLETE,
        libraryDir,
        `索引已有 ${skillId}，但中心库原件缺失`,
        '先修复中心库或重新扫描，再执行 adopt',
      ),
    ]);
  }
  if (record === undefined) {
    throw new AdoptError([
      invalid(
        CODES.CONFLICT_NAMING,
        libraryDir,
        `中心库已有同名目录但索引未登记：${skillId}`,
        '先清理或登记该目录；adopt 不会覆盖既有目录',
      ),
    ]);
  }
  if (computeChecksum(libraryDir) === hostDigest) {
    throw new AdoptError([
      invalid(
        CODES.RECONCILE_ACTION_UNSUPPORTED,
        skillId,
        '该 Skill 已在工作区且内容一致，adopt 不应覆盖',
        `请改用 reconcile --action track --id ${skillId} --host <宿主>`,
      ),
    ]);
  }
  throw new AdoptError([
    invalid(
      CODES.RECONCILE_ACTION_UNSUPPORTED,
      skillId,
      '该 Skill 已在工作区但内容不一致，adopt 不应覆盖',
      '请先用 repair 恢复宿主，或使用 accept 接受宿主内容',
    ),
  ]);
}

function normalizeStaging(staging: string): void {
  for (const path of [
    join(staging, 'skill_meta.yaml'),
    join(staging, '.git'),
    join(staging, 'node_modules'),
  ]) {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
  const visible = join(staging, SKILL_MARKER);
  const disabled = join(staging, DISABLED_MARKER);
  if (existsSync(visible) && existsSync(disabled)) {
    throw new AdoptError([
      invalid(
        CODES.YAML_INVALID,
        staging,
        'adopt 来源同时存在可见与禁用标记',
        '先修复副本的 SKILL.md / SKILL.md.disabled 冲突',
      ),
    ]);
  }
  if (!existsSync(visible) && existsSync(disabled)) renameWithRetry(disabled, visible);
}

function metaOf(
  input: AdoptInput,
  identity: AdoptIdentity,
  checksum: string,
): Record<string, unknown> {
  return {
    id: identity.skillId,
    name: identity.skillId,
    ...(identity.version === undefined ? {} : { version: identity.version }),
    description: identity.description,
    ...(identity.author === undefined ? {} : { author: identity.author }),
    ...(identity.license === undefined ? {} : { license: identity.license }),
    ...(identity.compatibility === undefined ? {} : { compatibility: identity.compatibility }),
    ...(identity.allowedTools === undefined ? {} : { allowed_tools: identity.allowedTools }),
    ...(identity.metadata === undefined ? {} : { metadata: identity.metadata }),
    ...(identity.extensions === undefined ? {} : { extensions: identity.extensions }),
    ...(identity.triggerKeywords === undefined
      ? {}
      : { trigger_keywords: identity.triggerKeywords }),
    status: identity.status,
    path: `./skills/${identity.skillId}`,
    source: { type: 'unknown' },
    targets: [
      {
        target: identity.targetId,
        scope: 'global',
        path: copyPathOf(identity.targetId, identity.skillId),
        mode: 'copy',
        enabled: identity.status === 'enabled',
      },
    ],
    created_at: input.now,
    updated_at: input.now,
    checksum,
  };
}

function identityOf(input: AdoptInput): AdoptIdentity {
  const { item, layout, index, selection } = input;
  assertAdoptableShape(item);
  const front = frontmatterIdentity(item);
  const { findings, ...frontFields } = front;
  const target = targetIdentity({
    layout,
    index,
    selection,
    skillId: front.skillId,
    status: front.status,
  });
  const hostDigest = computeLandingChecksum({ targetPath: item.target_path, format: 'skill' });
  assertLibraryAdoptable(layout, index, front.skillId, hostDigest);
  return {
    hostDir: item.target_path,
    ...frontFields,
    ...target,
    hostDigest,
    findings,
  };
}

/** 读取来源、生成可校验的暂存中心库；失败时清理暂存并抛出 AdoptError。 */
export function prepareAdopt(input: AdoptInput): PreparedAdopt {
  const identity = identityOf(input);
  const staging = mkdtempSync(join(input.layout.skillsDir, '.adopt-'));
  try {
    copyTree(identity.hostDir, staging);
    normalizeStaging(staging);
    const checksum = computeChecksum(staging);
    const meta = metaOf(input, identity, checksum);
    const findings = validateMetaRecord(meta, {
      dirName: identity.skillId,
      dirPath: staging,
    });
    if (findings.some((item) => item.severity === 'error')) throw new AdoptError(findings);
    atomicWriteFile(join(staging, 'skill_meta.yaml'), stringifyYaml(meta));
    const digests = safeDigests(staging);
    return {
      ...identity,
      staging,
      libraryDir: join(input.layout.skillsDir, identity.skillId),
      checksum,
      ...(digests === undefined ? {} : { digests }),
      meta,
      findings: identity.findings,
    };
  } catch (error) {
    if (existsSync(staging)) removeTree(staging);
    throw error;
  }
}
