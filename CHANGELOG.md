# Changelog

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
