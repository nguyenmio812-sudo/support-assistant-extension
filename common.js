(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SupportAssistantCommon = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const PRIORITIES = new Set(["P1", "P2", "P3", "P4"]);
  const DEFAULT_OPENAI_MODEL = "gpt-5-mini";

  function cleanText(value, maxLength = 500) {
    return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
  }

  function normalizeHttpsOrigin(value) {
    const raw = cleanText(value, 2048);
    if (!raw) return "";
    let url;
    try { url = new URL(raw); } catch { throw new Error("URL không hợp lệ."); }
    if (url.protocol !== "https:") throw new Error("URL bắt buộc phải dùng HTTPS.");
    if (url.username || url.password) throw new Error("URL không được chứa username hoặc password.");
    if (url.search || url.hash) throw new Error("Base URL không được chứa query hoặc fragment.");
    return url.origin;
  }

  function normalizeJiraBaseUrl(value) {
    const origin = normalizeHttpsOrigin(value);
    if (!origin) return "";
    const url = new URL(origin);
    if (!url.hostname.endsWith(".atlassian.net")) {
      throw new Error("Giai đoạn 1 chỉ cho phép Jira Cloud (*.atlassian.net).");
    }
    return origin;
  }

  function normalizeJiraProjectKey(value) {
    const key = cleanText(value, 32).toUpperCase();
    if (key && !/^[A-Z][A-Z0-9_]{1,31}$/.test(key)) throw new Error("Project Key Jira không hợp lệ.");
    return key;
  }

  function extractJiraIssueKey(value) {
    let url;
    try { url = new URL(cleanText(value, 2048)); } catch { return null; }
    const match = url.pathname.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:\/|$)/i);
    return match ? match[1].toUpperCase() : null;
  }

  function normalizeJiraIssueUrl(value, jiraBaseUrl) {
    const base = normalizeJiraBaseUrl(jiraBaseUrl);
    const raw = cleanText(value, 2048);
    let url;
    try { url = new URL(raw); } catch { throw new Error("Link Jira không hợp lệ."); }
    if (url.protocol !== "https:" || url.origin !== base) throw new Error("Link Jira phải thuộc đúng Jira tenant đã cấu hình.");
    const key = extractJiraIssueKey(raw);
    if (!key) throw new Error("Link Jira cần đúng dạng .../browse/PROJ-123.");
    return `${base}/browse/${key}`;
  }

  function normalizeCrispUrl(value) {
    const raw = cleanText(value, 2048);
    if (!raw) return "";
    let url;
    try { url = new URL(raw); } catch { throw new Error("Link Crisp không hợp lệ."); }
    if (url.protocol !== "https:" || !/(^|\.)crisp\.chat$/i.test(url.hostname)) {
      throw new Error("Link nguồn phải là URL HTTPS thuộc crisp.chat.");
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.toString();
  }

  function validateSummary(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI trả về dữ liệu không hợp lệ.");
    const summary = cleanText(value.summary, 4000);
    const priority = cleanText(value.priority, 2).toUpperCase();
    const tags = Array.isArray(value.tags) ? value.tags.map((tag) => cleanText(tag, 40)).filter(Boolean).slice(0, 4) : [];
    if (!summary) throw new Error("AI không trả về nội dung tóm tắt.");
    if (!PRIORITIES.has(priority)) throw new Error("AI trả về priority không hợp lệ.");
    if (tags.length < 1) throw new Error("AI không trả về tag hợp lệ.");
    return { summary, priority, tags };
  }

  function redactSensitiveText(value) {
    return cleanText(value, 14000)
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL_REDACTED]")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ATATT[A-Za-z0-9_-]{12,})\b/g, "[TOKEN_REDACTED]")
      .replace(/\b(?:\+?\d[\d .()-]{7,}\d)\b/g, "[PHONE_REDACTED]");
  }

  function safeErrorMessage(error, fallback = "Có lỗi xảy ra.") {
    const message = cleanText(error && error.message ? error.message : error, 500);
    return message || fallback;
  }

  return {
    DEFAULT_OPENAI_MODEL, cleanText, normalizeHttpsOrigin, normalizeJiraBaseUrl,
    normalizeJiraProjectKey, extractJiraIssueKey, normalizeJiraIssueUrl,
    normalizeCrispUrl, validateSummary, redactSensitiveText, safeErrorMessage,
  };
});
