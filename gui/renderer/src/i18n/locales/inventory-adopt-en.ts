export default {
  title: 'Bulk adopt into workspace',
  subtitle:
    'The kernel previewed every adoptable user copy; only the copies you selected are listed below.',
  policy:
    'Duplicate Skill IDs and occupied targets are skipped by default. Each copy keeps its own transaction, so one failure does not block the rest.',
  previewTitle: 'Selected adoption preview',
  sourcePath: 'Source',
  target: 'Workspace target',
  frontmatter: 'Frontmatter',
  conflict: 'Conflict',
  description: 'Description: {value}',
  version: 'Version: {value}',
  missingValue: '(not declared)',
  noSelection: 'None of the selected copies is eligible for bulk adoption.',
  conflictValues: {
    none: 'No conflict',
    same_content: 'Same content already exists',
    different_content: 'Different content already exists',
    target_occupied: 'Target occupied by another Skill',
  },
} as const;
