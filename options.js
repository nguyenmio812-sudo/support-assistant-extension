const fields = ["claudeApiKey", "jiraBaseUrl", "jiraEmail", "jiraApiToken", "jiraProjectKey"];

(async function load() {
  const cfg = await chrome.storage.sync.get(fields);
  fields.forEach((f) => {
    if (cfg[f]) document.getElementById(f).value = cfg[f];
  });
})();

document.getElementById("saveBtn").addEventListener("click", async () => {
  const cfg = {};
  fields.forEach((f) => (cfg[f] = document.getElementById(f).value.trim()));
  await chrome.storage.sync.set(cfg);
  const msg = document.getElementById("savedMsg");
  msg.style.display = "block";
  setTimeout(() => (msg.style.display = "none"), 2000);
});
