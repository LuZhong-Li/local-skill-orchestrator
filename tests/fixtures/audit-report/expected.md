# Skill audit report

- Generated: 2026-10-23T04:01:02Z
- Tool version: 0.6.0
- Workspace: <workspace>
- Observed at: 2026-10-23T04:00:00Z
- Hosts: claude, codex, cursor

## Overview

| Metric | Count |
| --- | --- |
| Declared | 6 |
| Distributed | 1 |
| Missing | 1 |
| Checksum drift | 1 |
| Frontmatter drift | 1 |
| Version drift | 1 |
| Visibility mismatch | 1 |
| Undeclared | 1 |
| Unmapped | 1 |
| Workspace only | 1 |
| Insufficient | 1 |

## Skill matrix

| Skill | Target | Status | Evidence | Details |
| --- | --- | --- | --- | --- |
| skill-a | claude | distributed | authoritative/authoritative/authoritative | — |
| skill-a | codex | missing | insufficient/insufficient/insufficient | ledger_missing |
| skill-b | claude | drift (checksum) | authoritative/authoritative/authoritative | content_drift, checksum_drift |
| skill-b | codex | drift (frontmatter) | authoritative/authoritative/authoritative | description: Claude description / Codex description |
| skill-b | cursor | drift (version) | authoritative/authoritative/authoritative | claude: 1.0.0; cursor: 2.0.0 |
| skill-c | claude | undeclared | insufficient/inferred/insufficient | target_undeclared |
| skill-c | codex | visibility_mismatch | authoritative/authoritative/authoritative | visibility_mismatch |
| skill-d | claude | insufficient | insufficient/insufficient/insufficient | ledger_unreadable |
| skill-d | codex | workspace_only | insufficient/insufficient/insufficient | workspace_target_not_host |
| skill-e | claude | unmapped | insufficient/insufficient/insufficient | target_unmapped |

## Missing by host

- codex: skill-a — ledger_missing

## Findings

| Severity | Rule | Skill | Target | Message |
| --- | --- | --- | --- | --- |
| error | W-MISSING-001 | skill-a | codex | Skill skill-a is missing from declared target codex. |
| warning | W-DRIFT-001 | skill-b | claude | Skill skill-b has content checksum drift on claude. |
| warning | W-DRIFT-002 | skill-b | codex | Skill skill-b has frontmatter drift on codex: description. |
| warning | W-DRIFT-003 | skill-b | cursor | Skill skill-b has version drift on cursor. |
| warning | W-MISSING-003 | skill-c | codex | Skill skill-c visibility does not match expectations on codex. |
| note | W-MISSING-002 | skill-c | claude | Skill skill-c exists on claude but is not declared in targets. |
| note | W-MISSING-004 | skill-d | claude | Skill skill-d on claude has insufficient audit evidence. |
| note | W-MISSING-004 | skill-e | claude | Skill skill-e on claude has insufficient audit evidence. |
