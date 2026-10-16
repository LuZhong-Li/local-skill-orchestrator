import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findNeedleInTree, maintainerConsumptionVerdict } from '../../scripts/maintainer-probe.mjs';

const NEEDLE = 'skill-manager <3338004299@qq.com>';

/** 造一个 AppImage 解包目录的近似结构（desktop 条目 + 一个同名字符串文件） */
function fixture(
  options: { withNeedle: boolean } | { copyNeedleElsewhere: boolean },
  name: string,
) {
  const dir = mkdtempSync(join(tmpdir(), `sm-probe-${name}-`));
  mkdirSync(join(dir, 'usr', 'share', 'applications'), { recursive: true });
  const withNeedle = 'withNeedle' in options ? options.withNeedle : true;
  writeFileSync(
    join(dir, 'usr', 'share', 'applications', 'skill-manager.desktop'),
    [
      '[Desktop Entry]',
      'Name=skill-manager',
      ...(withNeedle ? [`Maintainer=${NEEDLE}`] : []),
      'Type=Application',
      '',
    ].join('\n'),
  );
  // 二进制类文件不应被扫描（模拟 AppImage 内的可执行文件）
  writeFileSync(join(dir, 'AppRun'), `#!/bin/sh\n# ${NEEDLE}\n`);
  return dir;
}

test('maintainer 实测：命中含该字段的产物、未命中移除该字段的产物 → consumed', () => {
  const withDir = fixture({ withNeedle: true }, 'with');
  const withoutDir = fixture({ withNeedle: false }, 'without');

  const withResult = findNeedleInTree({ root: withDir, needle: NEEDLE });
  const withoutResult = findNeedleInTree({ root: withoutDir, needle: NEEDLE });

  assert.equal(withResult.hits.length, 1, '只应在 desktop 条目里命中');
  assert.match(withResult.hits[0].path, /skill-manager\.desktop$/);
  assert.match(withResult.hits[0].lines[0], /^Maintainer=/);
  assert.equal(withoutResult.hits.length, 0);
  assert.equal(
    maintainerConsumptionVerdict({
      withHits: withResult.hits,
      withoutHits: withoutResult.hits,
    }),
    'consumed',
  );
});

test('maintainer 实测：含该字段的产物也未命中 → not-consumed', () => {
  const dir = fixture({ withNeedle: false }, 'none');
  const result = findNeedleInTree({ root: dir, needle: NEEDLE });
  assert.equal(result.hits.length, 0);
  assert.equal(
    maintainerConsumptionVerdict({ withHits: result.hits, withoutHits: [] }),
    'not-consumed',
  );
});

test('maintainer 实测：两版都命中 → ambiguous（字符串来自别处，不能据此判定）', () => {
  const withDir = fixture({ withNeedle: true }, 'amb-a');
  const withoutDir = fixture({ withNeedle: true }, 'amb-b');

  const withHits = findNeedleInTree({ root: withDir, needle: NEEDLE }).hits;
  const withoutHits = findNeedleInTree({ root: withoutDir, needle: NEEDLE }).hits;
  assert.equal(withHits.length > 0, true);
  assert.equal(
    maintainerConsumptionVerdict({ withHits, withoutHits }),
    'ambiguous',
    '两版都命中说明命中来源与该字段无关',
  );
});
