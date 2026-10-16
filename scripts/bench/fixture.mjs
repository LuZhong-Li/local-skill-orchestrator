/**
 * M3 规模夹具生成器（确定性、可复现、不入库）。
 *
 * 依据：`docs/design/m3-benchmark.md` §2.1（分布参数，首测前冻结）与 §2.2（目录布局、文件数公式）。
 *
 * 设计要点：
 *   一、**结构先行**：`planFixture()` 只产出结构计划（技能清单、文件清单与文本内容、依赖边、计数），
 *       `writeFixture()` 再按计划落盘。同种子 + 同 N 的两次计划深度相等，落盘内容逐字节一致；
 *   二、**配额化分布**：占比与档位用精确配额分配（而非逐次抽样），因此文件数可按公式核对：
 *       `文件数 = N + (N − 内容缺失样本数) + 资产文件总数`；
 *   三、**无效样本是真的无效**：五类无效按内核实测的问题码构造
 *       （`E-FIELD-001` / `E-STATUS-001` / `E-ID-003` / `E-HASH-002` / `E-YAML-001`），
 *       由 `tests/unit/bench-fixture.test.ts` 用 `scanWorkspace` 逐类复核；
 *   四、**不入库**：默认落系统临时目录，仓库内路径只用于显式覆盖（并被 `.gitignore` 覆盖）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 默认种子（`0x5A17` = 23063，设计 §2.1 冻结取值） */
export const DEFAULT_SEED = 0x5a17;

/** 已冻结的分布参数（改动须走设计变更，`tests/contract/bench-thresholds.test.ts` 会比对文档） */
export const DISTRIBUTION = {
  /** 合法（无问题码）/ 合法带警告 / 无效 */
  categories: { valid: 0.87, warned: 0.05, invalid: 0.08 },
  /** 五类无效，按内核实测的问题码构造，按序轮转分摊 */
  invalidKinds: ['missing-required', 'status-enum', 'id-dir-mismatch', 'no-content', 'bad-yaml'],
  /** 描述长度三档（字符数） */
  descriptionBands: [
    { name: 'short', min: 12, max: 80, weight: 0.4 },
    { name: 'medium', min: 80, max: 400, weight: 0.45 },
    { name: 'long', min: 400, max: 1024, weight: 0.15 },
  ],
  /** 触发关键词数量（0 ~ 10 个，单个 ≤ 32 字符） */
  triggerKeywords: { min: 0, max: 10, maxLength: 32 },
  /** 每技能资产数 0 ~ 4，权重均值恰为 1（保证 N=1000 约 3000 文件） */
  assetCountWeights: [0.35, 0.45, 0.1, 0.05, 0.05],
  /** 资产单文件大小 = 1KB × 2^e，e ∈ [0, 8)，均值 31.875 KB */
  assetSizeExponent: { min: 0, max: 8 },
  /** 夹具内依赖出度 0 ~ 3 的配额权重 */
  outDegreeWeights: [0.25, 0.35, 0.25, 0.15],
  /** 依赖扇入上界（构造期保证） */
  maxInDegree: 2,
  /** 悬空依赖（指向夹具外标识）的占比 */
  danglingDependency: 0.05,
  /** 「被依赖方无效」场景：直接依赖无效技能的**叶子**依赖方个数（级联止于其自身） */
  dependsOnInvalidMinimum: 2,
  /** 级联链深度（无效技能 ← 依赖方 ← 依赖方 ……），用于覆盖依赖可用性的不动点迭代 */
  cascadeChainDepth: 3,
  /** 依赖目标候选窗口（按标识序号回看，越界回绕） */
  dependencyWindow: 8,
};

/** 五类无效样本对应的内核问题码（实测锚点：`tests/unit/bench-fixture.test.ts` 用 `scanWorkspace` 逐类复核） */
export const INVALID_KIND_CODES = {
  'missing-required': 'E-FIELD-001',
  'status-enum': 'E-STATUS-001',
  'id-dir-mismatch': 'E-ID-003',
  'no-content': 'E-HASH-002',
  'bad-yaml': 'E-YAML-001',
};

/** mulberry32：小型确定性 PRNG（无外部依赖，同种子同序列） */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'skill',
  'metadata',
  'delivery',
  'host',
  'render',
  'validation',
  'index',
  '备份',
  '导出',
  '校验',
  '分发',
  '索引',
];

/** 精确配额：先按权重取整，余数按小数部分从大到小补足（同分按序号），保证合计等于 total */
export function allocateExact(total, weights) {
  const raw = weights.map((weight) => weight * total);
  const counts = raw.map((value) => Math.floor(value));
  let remainder = total - counts.reduce((sum, value) => sum + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => (b.fraction === a.fraction ? a.index - b.index : b.fraction - a.fraction));
  for (const item of order) {
    if (remainder <= 0) break;
    counts[item.index] += 1;
    remainder -= 1;
  }
  return counts;
}

/** 确定性洗牌（Fisher-Yates，用同一 PRNG 序列） */
function shuffle(items, rand) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** 由词表拼出指定字符数的确定性文本 */
function textOfLength(length, salt) {
  let text = '';
  let cursor = 0;
  while (text.length < length) {
    const word = WORDS[(cursor + salt) % WORDS.length];
    text += text.length === 0 ? word : ` ${word}`;
    cursor += 1;
  }
  return text.slice(0, length);
}

const SKILL_DIR_PREFIX = 'bench-skill-';

/** 技能目录名（标识形态合规：小写、短横线分隔、定长数字后缀） */
function dirNameOf(index) {
  return `${SKILL_DIR_PREFIX}${String(index + 1).padStart(4, '0')}`;
}

/** 元文件文本：按样本类别生成（无效样本的违规形态逐类固定） */
function metaTextOf(skill) {
  const { dir, metaId, category, invalidKind, description, triggerKeywords, version } = skill;
  const lines = [`id: ${metaId}`, `name: ${metaId}`, `version: "${version}"`];
  lines.push(`description: ${JSON.stringify(description)}`);
  lines.push('author: bench', 'license: MIT');

  if (invalidKind === 'bad-yaml') {
    // 元文件不可解析（缩进非法）→ 实测判 E-YAML-001
    return `id: ${metaId}\n  name: ${metaId}\n`;
  }

  if (invalidKind === 'missing-required') {
    // 缺必填字段（status / path / source / targets 均缺失）→ 实测判 E-FIELD-001
    return `${lines.slice(0, 2).join('\n')}\n`;
  }

  lines.push(`status: ${invalidKind === 'status-enum' ? 'paused' : 'enabled'}`);
  lines.push(`path: ./skills/${dir}`);

  if (triggerKeywords.length > 0) {
    lines.push('trigger_keywords:');
    for (const keyword of triggerKeywords) lines.push(`  - ${keyword}`);
  }

  const declared = [...skill.dependsOn, ...(skill.danglingDep === null ? [] : [skill.danglingDep])];
  if (declared.length > 0) {
    lines.push('dependencies:', '  skills:');
    for (const name of declared) lines.push(`    - ${name}`);
  }

  lines.push('source:', '  type: local');
  lines.push('targets:');
  lines.push('  - target: claude', '    scope: global', `    path: .claude/skills/${dir}`);
  lines.push('    mode: copy', '    enabled: true', '    file_map:', '      SKILL.md: SKILL.md');

  if (category === 'warned') {
    // 白名单外字段：实测为警告级（W-FIELD-004，记录仍判 ok）
    lines.push('bench_extra_field: 1');
  }
  return `${lines.join('\n')}\n`;
}

/** SKILL.md 文本：frontmatter + 正文 */
function skillMdOf(skill) {
  const frontmatter = [
    '---',
    `name: ${skill.indexId}`,
    `description: ${JSON.stringify(skill.description)}`,
    '---',
    '',
  ];
  const body = [`# ${skill.indexId}`, '', textOfLength(160, skill.ordinal), ''];
  return `${frontmatter.concat(body).join('\n')}\n`;
}

/** 资产文件：内容由大小与序号确定（无随机字节，避免生成成为成本瓶颈） */
function assetBytes(size, ordinal) {
  return Buffer.alloc(size, (ordinal * 31) & 0xff);
}

/**
 * 产出夹具结构计划（纯函数，无文件系统副作用）。
 *
 * 返回：`{ schema, seed, n, counts, skills }`，其中每个技能含落盘所需的全部内容与大小，
 * 因此 `counts.files` / `counts.bytes` 与实际落盘逐字节一致。
 */
export function planFixture({ seed = DEFAULT_SEED, n = 1000 } = {}) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`规模档位必须是正整数：${String(n)}`);
  }
  const rand = mulberry32(seed);
  const indices = Array.from({ length: n }, (_, index) => index);

  // 一、类别配额（合法 / 合法带警告 / 无效）
  const categoryQuotas = allocateExact(n, [
    DISTRIBUTION.categories.valid,
    DISTRIBUTION.categories.warned,
    DISTRIBUTION.categories.invalid,
  ]);
  const categories = ['valid', 'warned', 'invalid'];
  const categoryOf = new Array(n).fill('valid');
  const categoryOrder = shuffle(indices, rand);
  let cursor = 0;
  for (let k = 0; k < categories.length; k += 1) {
    for (let count = 0; count < categoryQuotas[k]; count += 1) {
      categoryOf[categoryOrder[cursor]] = categories[k];
      cursor += 1;
    }
  }

  // 二、无效样本按序轮转分摊五类
  const invalidIndices = indices.filter((index) => categoryOf[index] === 'invalid');
  const invalidKindOf = new Map();
  invalidIndices.forEach((index, position) => {
    invalidKindOf.set(
      index,
      DISTRIBUTION.invalidKinds[position % DISTRIBUTION.invalidKinds.length],
    );
  });
  const noContentIndices = new Set(
    invalidIndices.filter((index) => invalidKindOf.get(index) === 'no-content'),
  );

  // 三、描述长度档与资产数配额
  const bandQuotas = allocateExact(
    n,
    DISTRIBUTION.descriptionBands.map((band) => band.weight),
  );
  const bandOf = new Array(n).fill(0);
  const bandOrder = shuffle(indices, rand);
  cursor = 0;
  for (let band = 0; band < bandQuotas.length; band += 1) {
    for (let count = 0; count < bandQuotas[band]; count += 1) {
      bandOf[bandOrder[cursor]] = band;
      cursor += 1;
    }
  }

  const assetEligible = indices.filter((index) => !noContentIndices.has(index));
  const assetQuotas = allocateExact(assetEligible.length, DISTRIBUTION.assetCountWeights);
  const assetCountOf = new Map();
  const assetOrder = shuffle(assetEligible, rand);
  cursor = 0;
  for (let count = 0; count < assetQuotas.length; count += 1) {
    for (let k = 0; k < assetQuotas[count]; k += 1) {
      assetCountOf.set(assetOrder[cursor], count);
      cursor += 1;
    }
  }

  // 四、依赖出度配额与悬空依赖配额
  const outDegreeQuotas = allocateExact(n, DISTRIBUTION.outDegreeWeights);
  const outDegreeOf = new Map();
  const outDegreeOrder = shuffle(indices, rand);
  cursor = 0;
  for (let degree = 0; degree < outDegreeQuotas.length; degree += 1) {
    for (let k = 0; k < outDegreeQuotas[degree]; k += 1) {
      outDegreeOf.set(outDegreeOrder[cursor], degree);
      cursor += 1;
    }
  }
  const danglingQuota = allocateExact(n, [
    1 - DISTRIBUTION.danglingDependency,
    DISTRIBUTION.danglingDependency,
  ])[1];
  const danglingSet = new Set(shuffle(indices, rand).slice(0, danglingQuota));

  // 五、技能骨架（标识、文本、资产清单）
  const skills = indices.map((index) => {
    const dir = dirNameOf(index);
    const invalidKind = invalidKindOf.get(index) ?? null;
    const category = categoryOf[index];
    const band = DISTRIBUTION.descriptionBands[bandOf[index]];
    const length = band.min + Math.floor(rand() * Math.max(1, band.max - band.min));
    const description = textOfLength(length, index);
    const keywordCount =
      DISTRIBUTION.triggerKeywords.min +
      Math.floor(
        rand() * (DISTRIBUTION.triggerKeywords.max - DISTRIBUTION.triggerKeywords.min + 1),
      );
    const triggerKeywords = Array.from(
      { length: keywordCount },
      (_, position) => `kw-${index + 1}-${position + 1}`,
    );
    const assetCount = assetCountOf.get(index) ?? 0;
    const assets = Array.from({ length: assetCount }, (_, position) => {
      const exponent =
        DISTRIBUTION.assetSizeExponent.min +
        Math.floor(
          rand() * (DISTRIBUTION.assetSizeExponent.max - DISTRIBUTION.assetSizeExponent.min),
        );
      return { path: `assets/blob-${position + 1}.bin`, bytes: 1024 * 2 ** exponent };
    });
    const metaId = invalidKind === 'id-dir-mismatch' ? `${dir}-alias` : dir;
    return {
      ordinal: index,
      dir,
      metaId,
      /** 索引中实际出现的标识：元文件不可解析时内核回落为目录名 */
      indexId: invalidKind === 'bad-yaml' ? dir : metaId,
      category,
      invalidKind,
      band: band.name,
      description,
      triggerKeywords,
      version: `0.${(index % 9) + 1}.${index % 7}`,
      assets,
      dependsOn: [],
      danglingDep: danglingSet.has(index)
        ? `external-tool-${String(index + 1).padStart(4, '0')}`
        : null,
    };
  });

  // 六、依赖边：目标一律取**序号更小**的技能（构造上必然无环，依赖图是 DAG）。
  //     内核在扫描期对依赖可用性做不动点迭代，无环是让「有效无效数」可精确预言的前提
  //     （实测：带环构造会触发环检测并把级联扩散到半个工作区，见设计 2.1.2）。
  const inDegree = new Map(skills.map((skill) => [skill.indexId, 0]));
  const byIndex = new Map(skills.map((skill) => [skill.ordinal, skill]));
  for (const skill of skills) {
    const degree = outDegreeOf.get(skill.ordinal) ?? 0;
    if (degree === 0) continue;
    const window = DISTRIBUTION.dependencyWindow;
    const offset = Math.floor(rand() * window);
    for (let step = 0; step < window && skill.dependsOn.length < degree; step += 1) {
      const candidateIndex = skill.ordinal - 1 - ((offset + step) % window);
      if (candidateIndex < 0) continue;
      const candidate = byIndex.get(candidateIndex);
      if (candidate === undefined) continue;
      if (skill.dependsOn.includes(candidate.indexId)) continue;
      // 内核判无效的技能不作为一般依赖目标：级联规模只由第七步的有界构造决定（见设计 2.1.2）
      if (candidate.category === 'invalid' || candidate.danglingDep !== null) continue;
      if ((inDegree.get(candidate.indexId) ?? 0) >= DISTRIBUTION.maxInDegree) continue;
      skill.dependsOn.push(candidate.indexId);
      inDegree.set(candidate.indexId, (inDegree.get(candidate.indexId) ?? 0) + 1);
    }
  }

  // 七、有界级联：「被依赖方无效」会沿依赖方向级联（内核对可用性做不动点迭代），
  //     因此依赖方一律取**序号更大**且**零扇入**的合法技能（自己不再被依赖，级联不向外扩散）：
  //     ① 一个无效技能被深度 3 的链依赖（A ← B ← C ← D，D 为链尾）；
  //     ② 另有 2 个无效技能各被一个叶子依赖方引用。
  //     有效无效数由第八步按 DAG 逐序推导，不靠手工估算。
  const dependedOnInvalid = [];
  const cascadeChain = [];
  const usedDependents = new Set();
  // 目标只取「元文件标识 = 目录名」的无效样本：标识与目录名不一致的样本在依赖判定里
  // 走的是另一条路径（声明名解析不到，报 `E-DEP-001` 而非 `E-VALIDATION-002`），
  // 留在通用构造里会混淆「被依赖方无效」的语义。
  const invalidSkills = invalidIndices
    .map((index) => byIndex.get(index))
    .filter((skill) => skill !== undefined && skill.metaId === skill.dir);

  const leafDependentsOf = (minimumOrdinal) =>
    skills.filter(
      (skill) =>
        skill.category === 'valid' &&
        skill.danglingDep === null &&
        !usedDependents.has(skill.ordinal) &&
        skill.ordinal > minimumOrdinal &&
        (inDegree.get(skill.indexId) ?? 0) === 0 &&
        skill.dependsOn.length < 3,
    );

  const chainHead = invalidSkills[0];
  if (chainHead !== undefined) {
    let target = chainHead;
    for (let depth = 0; depth < DISTRIBUTION.cascadeChainDepth; depth += 1) {
      const dependent = leafDependentsOf(target.ordinal)[0];
      if (dependent === undefined) break;
      dependent.dependsOn.push(target.indexId);
      inDegree.set(target.indexId, (inDegree.get(target.indexId) ?? 0) + 1);
      usedDependents.add(dependent.ordinal);
      cascadeChain.push(dependent.indexId);
      target = dependent;
    }
  }

  for (const invalid of invalidSkills.slice(1)) {
    if (dependedOnInvalid.length >= DISTRIBUTION.dependsOnInvalidMinimum) break;
    if ((inDegree.get(invalid.indexId) ?? 0) >= DISTRIBUTION.maxInDegree) continue;
    const dependent = leafDependentsOf(invalid.ordinal)[0];
    if (dependent === undefined) break;
    dependent.dependsOn.push(invalid.indexId);
    inDegree.set(invalid.indexId, (inDegree.get(invalid.indexId) ?? 0) + 1);
    usedDependents.add(dependent.ordinal);
    dependedOnInvalid.push(invalid.indexId);
  }

  // 八、内容（文本与资产大小在计划期即确定，计数与实际落盘逐字节一致）。
  //     元文件未渲染依赖声明的样本（缺必填字段、元文件不可解析）在内核眼里没有依赖，
  //     这里同步清空，保证计划与内核看到同一张图。
  for (const skill of skills) {
    if (skill.invalidKind === 'missing-required' || skill.invalidKind === 'bad-yaml') {
      skill.dependsOn = [];
      skill.danglingDep = null;
    }
    skill.metaText = metaTextOf(skill);
    skill.skillMdText = noContentIndices.has(skill.ordinal) ? null : skillMdOf(skill);
    skill.files = [
      { path: 'skill_meta.yaml', text: skill.metaText },
      ...(skill.skillMdText === null ? [] : [{ path: 'SKILL.md', text: skill.skillMdText }]),
      ...skill.assets.map((asset) => ({ path: asset.path, bytes: asset.bytes })),
    ];
    skill.fileCount = skill.files.length;
    skill.byteCount = skill.files.reduce(
      (sum, file) =>
        sum + (typeof file.text === 'string' ? Buffer.byteLength(file.text, 'utf8') : file.bytes),
      0,
    );
  }

  const invalidByKind = {};
  for (const kind of DISTRIBUTION.invalidKinds) {
    invalidByKind[kind] = invalidIndices.filter(
      (index) => invalidKindOf.get(index) === kind,
    ).length;
  }

  // 九、按 DAG 逐序推导内核的「有效无效」集合：自身有问题，或任一声明依赖无效（依赖一律指向更小序号）
  const ownInvalid = skills.filter(
    (skill) => skill.invalidKind !== null || skill.danglingDep !== null,
  );
  const invalidIds = new Set(ownInvalid.map((skill) => skill.indexId));
  for (const skill of skills) {
    if (invalidIds.has(skill.indexId)) continue;
    if (skill.dependsOn.some((dep) => invalidIds.has(dep))) invalidIds.add(skill.indexId);
  }

  const counts = {
    skills: n,
    valid: categoryQuotas[0],
    warned: categoryQuotas[1],
    invalid: categoryQuotas[2],
    invalidByKind,
    noContent: noContentIndices.size,
    assets: skills.reduce((sum, skill) => sum + skill.assets.length, 0),
    edges: skills.reduce((sum, skill) => sum + skill.dependsOn.length, 0),
    dangling: danglingSet.size,
    dependsOnInvalid: dependedOnInvalid,
    cascadeChain,
    /** 自身即无效的样本数（五类无效 + 悬空依赖） */
    ownInvalid: ownInvalid.length,
    /** 因依赖链级联而无效的样本数 */
    cascadeInvalid: invalidIds.size - ownInvalid.length,
    /** 有效无效数（内核判定）= 自身无效 + 级联无效 */
    effectiveInvalid: invalidIds.size,
    files: skills.reduce((sum, skill) => sum + skill.fileCount, 0),
    bytes: skills.reduce((sum, skill) => sum + skill.byteCount, 0),
    maxInDegree: Math.max(...skills.map((skill) => inDegree.get(skill.indexId) ?? 0)),
  };

  return { schema: 'bench-fixture/1', seed, n, counts, skills };
}

/**
 * 按计划落盘：`<root>/skills/<技能目录>/{skill_meta.yaml, SKILL.md, assets/*}`。
 * 夹具根即工作区根（`scan` 扫描 `<工作区>/skills`），因此不额外复制。
 */
export function writeFixture(plan, root) {
  let files = 0;
  let bytes = 0;
  for (const skill of plan.skills) {
    const skillDir = join(root, 'skills', skill.dir);
    mkdirSync(skillDir, { recursive: true });
    for (const file of skill.files) {
      const target = join(skillDir, ...file.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      if (typeof file.text === 'string') {
        writeFileSync(target, file.text);
        bytes += Buffer.byteLength(file.text, 'utf8');
      } else {
        writeFileSync(target, assetBytes(file.bytes, skill.ordinal));
        bytes += file.bytes;
      }
      files += 1;
    }
  }
  return { root, files, bytes };
}
