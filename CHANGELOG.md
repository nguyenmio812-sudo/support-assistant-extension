# Changelog

## 0.15.0

- Redesign the side panel as a responsive operational workspace without changing storage or API contracts.
- Add shared color, spacing, typography, radius, focus, and motion tokens.
- Reorganize summary, reply drafting, Jira search, manual issue entry, and issue tracking around clearer action hierarchy.
- Add responsive behavior for narrow and wide side panels.
- Redesign Settings into separate security, OpenAI, and Jira sections with local secret visibility controls.
- Add inline status regions, keyboard-accessible tabs, stronger focus states, and reduced-motion support.
- Add UI contract tests that protect DOM IDs, storage keys, issue fields, responsiveness, and baseline accessibility.

## 0.14.0

- Replace direct Claude integration with OpenAI Responses API.
- Add strict structured output validation and basic PII/token redaction.
- Move credentials from Chrome Sync to local storage and remove the legacy Claude key.
- Restrict default host access to OpenAI; request Jira tenant access at configuration time.
- Restrict conversation extraction to HTTPS `crisp.chat` pages and remove full-body fallback.
- Remove dynamic untrusted `innerHTML` rendering paths.
- Validate Crisp/Jira URLs and bind Jira links to the configured tenant.
- Preserve synchronization for completed Jira issues so reopened issues are detected.
- Add timeouts, retry/backoff, bounded Jira concurrency, tests, CI, and security/privacy documentation.
