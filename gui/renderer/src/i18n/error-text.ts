import type { Finding } from '../types.ts';
import { currentLocale, i18n, type SupportedLocale } from './index.ts';

type FindingLike = Pick<Finding, 'code' | 'message'> &
  Partial<Pick<Finding, 'severity' | 'remedy' | 'target' | 'source'>>;

function localizedExplanation(finding: FindingLike, locale: SupportedLocale): string {
  const key = `errors.codes.${finding.code}`;
  if (i18n.global.te(key, locale)) return String(i18n.global.t(key, {}, { locale }));
  return String(i18n.global.t('errors.withCode', { code: finding.code }, { locale }));
}

export function localizedFindingText(
  finding: FindingLike,
  locale: SupportedLocale = currentLocale(),
): string {
  const explanation = localizedExplanation(finding, locale);
  const diagnostic =
    finding.message.trim() === ''
      ? ''
      : String(i18n.global.t('errors.diagnostic', { message: finding.message }, { locale }));
  return [`${finding.code}: ${explanation}`, diagnostic].filter(Boolean).join(' ');
}

export function localizedFindingExplanation(
  finding: FindingLike,
  locale: SupportedLocale = currentLocale(),
): string {
  return localizedExplanation(finding, locale);
}

export function localizedFindingsText(findings: readonly FindingLike[]): string {
  return findings.map((finding) => localizedFindingText(finding)).join(' | ');
}
