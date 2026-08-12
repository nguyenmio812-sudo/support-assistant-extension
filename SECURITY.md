# Security policy

## Supported version

Only the latest tagged release is supported. This extension is internal software and must not be published publicly with production credentials.

## Reporting

Report suspected credential exposure, unauthorized data access, prompt injection, or incorrect cross-conversation extraction privately to the repository owner. Do not include customer conversations or secrets in an issue.

## Credential incident procedure

1. Disable the affected extension release.
2. Revoke and rotate the OpenAI API key and Jira token.
3. Review OpenAI usage and Jira audit logs.
4. Remove affected ZIP packages from internal distribution.
5. Document impact without copying customer content into the incident ticket.

## Known Phase 1 limitation

OpenAI and Jira credentials are stored in `chrome.storage.local` and used by the MV3 service worker. This reduces accidental Chrome Sync exposure but is not a secret vault. Production rollout requires the Phase 2 authenticated backend proxy.
