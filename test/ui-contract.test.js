const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const sidepanelHtml = fs.readFileSync("sidepanel.html", "utf8");
const sidepanelJs = fs.readFileSync("sidepanel.js", "utf8");
const optionsHtml = fs.readFileSync("options.html", "utf8");
const optionsJs = fs.readFileSync("options.js", "utf8");
const backgroundJs = fs.readFileSync("background.js", "utf8");

function idsUsedBy(source) {
  return [...source.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map((match) => match[1]);
}

test("all static element IDs used by sidepanel logic remain in the HTML", () => {
  const missing = [...new Set(idsUsedBy(sidepanelJs))].filter((id) => !sidepanelHtml.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test("all static element IDs used by options logic remain in the HTML", () => {
  const missing = [...new Set(idsUsedBy(optionsJs))].filter((id) => !optionsHtml.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test("configuration storage keys remain stable", () => {
  for (const key of ["openaiApiKey", "openaiModel", "jiraBaseUrl", "jiraEmail", "jiraApiToken", "jiraProjectKey"]) {
    assert.match(backgroundJs, new RegExp(key));
    assert.match(optionsJs, new RegExp(key));
  }
});

test("issue data fields remain stable", () => {
  for (const key of ["id", "title", "sourceLink", "jiraLink", "slackLink", "status", "reminderSent", "reportedToCustomer", "priority", "createdAt"]) {
    assert.match(sidepanelJs, new RegExp(`${key}:`));
  }
});

test("sidepanel is responsive and loads the shared token system", () => {
  assert.match(sidepanelHtml, /styles\/tokens\.css/);
  assert.match(sidepanelHtml, /styles\/sidepanel\.css/);
  const css = fs.readFileSync("styles/sidepanel.css", "utf8");
  assert.doesNotMatch(css, /width:\s*380px/);
});

test("UI documents have unique IDs and explicit button types", () => {
  for (const html of [sidepanelHtml, optionsHtml]) {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
    assert.equal(buttons.every((button) => /\stype="button"/.test(button)), true);
  }
});

test("visible HTML copy avoids decorative emoji and em dashes", () => {
  const forbidden = /[—🎧⚙️📋🔁🔍👤⭐🔄⚠️✅📍📎✉️🕐✏️]/u;
  assert.doesNotMatch(sidepanelHtml, forbidden);
  assert.doesNotMatch(optionsHtml, forbidden);
});

test("UI keeps inline styles limited to initial visibility state", () => {
  for (const html of [sidepanelHtml, optionsHtml]) {
    const inlineStyles = [...html.matchAll(/\sstyle="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(inlineStyles.every((style) => style === "display:none"), true);
  }
  assert.doesNotMatch(sidepanelJs, /style\.cssText/);
});
