/**
 * 经验存储与检索。
 *
 * 每条经验一个 YAML 文件存放在工作区 experiences/ 目录；
 * 文件名即经验 id，天然避免并发写同一文件。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml, stringifyYaml } from '../../store/yaml/index.ts';
import type { ExperienceDecision, ExperienceRecord } from './types.ts';

/** 生成经验 id：时间戳 + 短随机。 */
export function newExperienceId(now: string): string {
  const ts = now.replace(/[-:]/g, '').replace(/\.\d+Z?$/, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return `exp-${ts}-${rand}`;
}

/** 由原始输入构造经验记录。 */
export function buildExperience(input: {
  id: string;
  problem: string;
  kind: string;
  involvesUi: boolean;
  stages: string[];
  decisions: ExperienceDecision[];
  docTypes: string[];
  provider: string;
  durationMs: number;
  createdAt: string;
}): ExperienceRecord {
  return {
    ...input,
    summary: input.problem.length > 60 ? `${input.problem.slice(0, 60)}…` : input.problem,
  };
}

/** 写入一条经验；目录不存在时自动创建。 */
export function saveExperience(experiencesDir: string, record: ExperienceRecord): void {
  mkdirSync(experiencesDir, { recursive: true });
  const file = join(experiencesDir, `${record.id}.yaml`);
  writeFileSync(file, stringifyYaml(record as unknown as Record<string, unknown>), 'utf8');
}

/** 读取一条经验；不存在返回 null。 */
export function loadExperience(experiencesDir: string, id: string): ExperienceRecord | null {
  const file = join(experiencesDir, `${id}.yaml`);
  if (!existsSync(file)) return null;
  const raw = parseYaml(readFileSync(file, 'utf8'), { source: file, target: file });
  return raw as unknown as ExperienceRecord;
}

/** 列出全部经验，按时间倒序。 */
export function listExperiences(experiencesDir: string): ExperienceRecord[] {
  if (!existsSync(experiencesDir)) return [];
  const records: ExperienceRecord[] = [];
  for (const name of readdirSync(experiencesDir)) {
    if (!name.endsWith('.yaml')) continue;
    const id = name.slice(0, -'.yaml'.length);
    const record = loadExperience(experiencesDir, id);
    if (record !== null) records.push(record);
  }
  return records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** 简单关键词检索：匹配问题原文、摘要、分类与问答。 */
export function searchExperiences(
  experiencesDir: string,
  keyword: string,
  limit = 10,
): ExperienceRecord[] {
  const needle = keyword.toLowerCase();
  const hits = listExperiences(experiencesDir).filter((record) => {
    if (record.problem.toLowerCase().includes(needle)) return true;
    if (record.summary.toLowerCase().includes(needle)) return true;
    if (record.kind.toLowerCase().includes(needle)) return true;
    if (record.decisions.some((d) => `${d.question} ${d.answer}`.toLowerCase().includes(needle)))
      return true;
    return false;
  });
  return hits.slice(0, limit);
}

/** 按关键词取最相似的一条经验（用于 --experience 预填）。 */
export function findSimilarExperience(
  experiencesDir: string,
  keyword: string,
): ExperienceRecord | null {
  const hits = searchExperiences(experiencesDir, keyword, 1);
  return hits[0] ?? null;
}
