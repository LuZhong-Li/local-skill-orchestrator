/** M6 audit 纯函数入口。 */
export {
  compareFrontmatterGroup,
  type AuditFrontmatterComparison,
  type AuditFrontmatterCopy,
} from './audit-frontmatter.ts';
export {
  renderAuditReport,
  renderHtml,
  renderMarkdown,
  renderSarif,
  SARIF_RULES,
} from './report-render.ts';
