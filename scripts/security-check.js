const fs = require("node:fs");

const runtimeFiles = ["manifest.json", "background.js", "common.js", "content.js", "options.js", "sidepanel.js"];
const content = runtimeFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
const failures = [];

if (/sk-(?:proj-)?[A-Za-z0-9_-]{20,}/.test(content)) failures.push("Possible OpenAI secret in runtime source");
if (/ATATT[A-Za-z0-9_-]{12,}/.test(content)) failures.push("Possible Atlassian token in runtime source");
if (/https?:\/\/\*\/\*/.test(fs.readFileSync("manifest.json", "utf8"))) failures.push("Broad host permission in manifest");
if (/\.innerHTML\s*=/.test(fs.readFileSync("sidepanel.js", "utf8"))) failures.push("innerHTML assignment in sidepanel");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Security baseline checks passed");
