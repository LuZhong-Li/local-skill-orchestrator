import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkReleaseConsistency,
  parseTagVersion,
  topVersionSection,
} from '../../scripts/release-guard.mjs';

const CHANGELOG_OK = [
  '# 变更记录',
  '',
  '## 0.1.0',
  '',
  '首个版本。',
  '',
  '### 功能概览',
  '',
  '- 16 条指令',
  '',
].join('\n');

test('版本守卫：tag 解析接受 v 前缀版本，拒绝其它形态', () => {
  assert.equal(parseTagVersion('v0.1.0'), '0.1.0');
  assert.equal(parseTagVersion(' v2.10.3-rc.1 '), '2.10.3-rc.1');
  assert.throws(() => parseTagVersion('0.1.0'), /不是合法的发布版本号/, '缺 v 前缀应拒绝');
  assert.throws(() => parseTagVersion('v0.1'), /不是合法的发布版本号/);
  assert.throws(() => parseTagVersion('release-0.1.0'), /不是合法的发布版本号/);
});

test('版本守卫：取 CHANGELOG 顶部已定版段，跳过「未发布」占位段', () => {
  const withUnreleased = [
    '# 变更记录',
    '',
    '## 未发布',
    '',
    '进行中。',
    '',
    '## 0.1.0',
    '',
    '首个版本。',
    '',
  ].join('\n');
  assert.deepEqual(topVersionSection(withUnreleased), {
    version: '0.1.0',
    body: '首个版本。',
  });
  assert.equal(topVersionSection('# 变更记录\n\n## 未发布\n\n进行中。\n'), undefined);
});

test('版本守卫：三方一致时通过', () => {
  const result = checkReleaseConsistency({
    tag: 'v0.1.0',
    changelogText: CHANGELOG_OK,
    packageVersions: { 'package.json': '0.1.0', 'gui/package.json': '0.1.0' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.version, '0.1.0');
});

test('版本守卫：三类反例各自中止（tag / CHANGELOG / package.json）', () => {
  const base = { changelogText: CHANGELOG_OK, packageVersions: { 'package.json': '0.1.0' } };

  const badTag = checkReleaseConsistency({ ...base, tag: 'v0.2.0' });
  assert.equal(badTag.ok, false);
  assert.match(
    badTag.reasons.join('；'),
    /CHANGELOG 顶部版本段为 0\.1\.0，与 tag 的 0\.2\.0 不一致/,
  );

  const badChangelog = checkReleaseConsistency({
    tag: 'v0.1.0',
    changelogText: '# 变更记录\n\n## 未发布\n\n进行中。\n',
    packageVersions: { 'package.json': '0.1.0' },
  });
  assert.equal(badChangelog.ok, false);
  assert.match(badChangelog.reasons.join('；'), /没有已定版的版本段/);

  const badPackage = checkReleaseConsistency({
    tag: 'v0.1.0',
    changelogText: CHANGELOG_OK,
    packageVersions: { 'package.json': '0.1.1' },
  });
  assert.equal(badPackage.ok, false);
  assert.match(badPackage.reasons.join('；'), /package\.json 的 version 为 0\.1\.1/);

  const badTagFormat = checkReleaseConsistency({ ...base, tag: '0.1.0' });
  assert.equal(badTagFormat.ok, false);
  assert.match(badTagFormat.reasons.join('；'), /不是合法的发布版本号/);
});
