# Data flow and privacy

When an agent explicitly clicks **Tóm tắt**, the extension reads the recognized conversation region on an HTTPS `crisp.chat` page. Before sending text to OpenAI, it applies best-effort redaction for email addresses, phone numbers, and common token formats. Redaction is not guaranteed to find every type of personal or confidential data.

The extension sends conversation text to OpenAI for summarization and reply drafting. It sends issue keys and requested fields to the configured Jira Cloud tenant for tracking. Issue tracking data and credentials are stored locally in the browser profile.

The extension does not intentionally send analytics or telemetry. Agents must preview the detected source and must not process conversations unless company policy permits the selected OpenAI API project to receive that customer data.

Production use requires documented retention rules, vendor approval, access control, credential rotation, and an authenticated backend proxy.
