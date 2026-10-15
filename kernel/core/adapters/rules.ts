/**
 * K-15 适配器层：规则路径形态（Cursor 的 .mdc）。
 *
 * 依据：调研文档 2.4 节（Cursor 规则：`.cursor/rules/` 下的 `.mdc` 文件，
 * 前置元数据三要素 description / globs / alwaysApply；`.md` 会被规则系统忽略）；
 * 设计文档 5.4 节（降级渲染规则）。
 *
 * 说明：本形态是本批唯一新增的形态实现——其余宿主复用技能形态或指令文件形态，
 * 不写宿主专有代码（M5-R7）。
 */
import { CODES, finding, type Finding } from '../../store/contract.ts';
import { stringifyYaml } from '../../store/yaml/index.ts';
import { hostById } from '../hosts/index.ts';
import type { ArtifactFile, RenderOutcome, RenderSource } from '../render/types.ts';

const SOURCE = 'adapters';

/**
 * 渲染规则文件：
 * - 前置元数据只给 `description` 与 `alwaysApply: false`（动态规则，由宿主按相关性决定生效）；
 * - 正文沿用技能正文；
 * - 文件名与落位路径由落位计划按注册表的规则路径模板展开（`.cursor/rules/<Skill 标识>.mdc`）。
 */
export function renderRuleFile(hostId: string, source: RenderSource): RenderOutcome {
  const findings: Finding[] = [];
  const description = source.description?.trim() ?? '';
  if (description === '') {
    findings.push(
      finding(CODES.FIELD_REQUIRED, {
        source: SOURCE,
        target: `${source.id}:description`,
        message: '规则文件缺少描述：Cursor 规则系统要求 description',
        remedy: '补齐内部描述后重新渲染；渲染层不虚构描述内容',
      }),
    );
  }

  const entry = hostById(hostId);
  if (entry === undefined) {
    findings.push(
      finding(CODES.ID_INVALID, {
        source: SOURCE,
        target: hostId,
        message: `未登记的宿主标识：${hostId}`,
        remedy: '取值必须来自宿主注册表',
      }),
    );
  }

  const front: Record<string, unknown> = {};
  if (description !== '') front['description'] = description;
  front['alwaysApply'] = false;
  const body = (source.body ?? '').replace(/\r\n?/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  const artifact: ArtifactFile = {
    kind: 'rule_file',
    path: `${source.id}.mdc`,
    content: `---\n${stringifyYaml(front)}---\n\n${body === '' ? '' : `${body}\n`}`,
  };

  return {
    host_id: hostId,
    field_mode: entry?.render_policy.field_mode ?? 'standard6',
    degraded: false,
    // 规则形态不具备技能形态的三项能力（与降级形态同口径声明）
    capability_gaps: ['auto_discovery', 'progressive_loading', 'tool_preapproval'],
    files: [artifact],
    ledger: {
      standard: description === '' ? ['alwaysApply'] : ['description', 'alwaysApply'],
      extensions: [],
      dropped: [],
    },
    findings,
  };
}
