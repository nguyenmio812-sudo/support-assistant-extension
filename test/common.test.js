const test = require("node:test");
const assert = require("node:assert/strict");
const common = require("../common.js");

test("normalizes an Atlassian Jira base URL", () => {
  assert.equal(common.normalizeJiraBaseUrl("https://example.atlassian.net/"), "https://example.atlassian.net");
});

test("rejects insecure or non-Atlassian Jira origins", () => {
  assert.throws(() => common.normalizeJiraBaseUrl("http://example.atlassian.net"), /HTTPS/);
  assert.throws(() => common.normalizeJiraBaseUrl("https://attacker.example"), /Jira Cloud/);
});

test("normalizes and binds issue links to the configured tenant", () => {
  assert.equal(
    common.normalizeJiraIssueUrl("https://example.atlassian.net/browse/abc2-42?x=1", "https://example.atlassian.net"),
    "https://example.atlassian.net/browse/ABC2-42",
  );
  assert.throws(
    () => common.normalizeJiraIssueUrl("https://other.atlassian.net/browse/ABC-1", "https://example.atlassian.net"),
    /đúng Jira tenant/,
  );
});

test("allows only HTTPS Crisp links", () => {
  assert.match(common.normalizeCrispUrl("https://app.crisp.chat/website/a/inbox"), /^https:\/\/app\.crisp\.chat\//);
  assert.throws(() => common.normalizeCrispUrl("https://example.com"), /crisp\.chat/);
});

test("validates and bounds AI summary output", () => {
  assert.deepEqual(common.validateSummary({ summary: "A", priority: "p2", tags: ["Bug"] }), {
    summary: "A", priority: "P2", tags: ["Bug"],
  });
  assert.throws(() => common.validateSummary({ summary: "A", priority: "urgent", tags: ["Bug"] }), /priority/);
});

test("redacts common sensitive values", () => {
  const syntheticKey = "sk-" + "a".repeat(24);
  const text = common.redactSensitiveText(`Mail me@example.com, call +84 912 345 678, key ${syntheticKey}`);
  assert.equal(text.includes("me@example.com"), false);
  assert.equal(text.includes("912 345 678"), false);
  assert.equal(text.includes(syntheticKey), false);
});
