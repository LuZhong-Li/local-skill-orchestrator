/** M6 审计报告的类型契约；不包含渲染、文件写入或审计逻辑。 */

export type AuditReportFormat = 'json' | 'markdown' | 'html' | 'sarif';

export interface AuditReportMeta {
  generated_at: string;
  tool_version: string;
  workspace: string;
  hosts: string[];
  observed_at: string;
  audit_file?: string;
}

export interface AuditReportDocument {
  format: AuditReportFormat;
  media_type: 'application/json' | 'text/markdown' | 'text/html' | 'application/sarif+json';
  extension: 'json' | 'md' | 'html' | 'sarif';
  content: string;
}
