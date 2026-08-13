const {
  DEFAULT_OPENAI_MODEL,
  cleanText,
  normalizeJiraBaseUrl,
  normalizeJiraProjectKey,
  safeErrorMessage,
} = SupportAssistantCommon;

const fields = ["openaiApiKey", "openaiModel", "jiraBaseUrl", "jiraEmail", "jiraApiToken", "jiraProjectKey"];

(async function load() {
  const cfg = await chrome.storage.local.get(fields);
  fields.forEach((field) => {
    const element = document.getElementById(field);
    if (element) element.value = cfg[field] || (field === "openaiModel" ? DEFAULT_OPENAI_MODEL : "");
  });
})();

function showMessage(message, isError = false) {
  const element = document.getElementById("savedMsg");
  element.textContent = message;
  element.className = `saved${isError ? " is-error" : ""}`;
  element.style.display = "block";
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

document.querySelectorAll(".secret-toggle").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.target);
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    button.textContent = reveal ? "Ẩn" : "Hiện";
    button.setAttribute("aria-label", `${reveal ? "Ẩn" : "Hiện"} ${input.id === "openaiApiKey" ? "API Key" : "Jira API Token"}`);
  });
});

document.getElementById("saveBtn").addEventListener("click", async () => {
  const button = document.getElementById("saveBtn");
  const originalLabel = button.textContent;
  setBusy(button, true);
  button.textContent = "Đang lưu...";

  try {
    const jiraBaseUrl = normalizeJiraBaseUrl(document.getElementById("jiraBaseUrl").value);
    const jiraProjectKey = normalizeJiraProjectKey(document.getElementById("jiraProjectKey").value);
    const openaiApiKey = cleanText(document.getElementById("openaiApiKey").value, 512);
    const openaiModel = cleanText(document.getElementById("openaiModel").value, 100) || DEFAULT_OPENAI_MODEL;
    const jiraEmail = cleanText(document.getElementById("jiraEmail").value, 254).toLowerCase();
    const jiraApiToken = cleanText(document.getElementById("jiraApiToken").value, 512);

    if (openaiApiKey && !openaiApiKey.startsWith("sk-")) throw new Error("OpenAI API key không đúng định dạng mong đợi.");
    if (jiraEmail && !/^\S+@\S+\.\S+$/.test(jiraEmail)) throw new Error("Email Jira không hợp lệ.");

    if (jiraBaseUrl) {
      const originPattern = `${jiraBaseUrl}/*`;
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (!granted) throw new Error("Bạn cần cấp quyền truy cập đúng Jira tenant để extension gọi Jira API.");
    }

    await chrome.storage.local.set({ openaiApiKey, openaiModel, jiraBaseUrl, jiraEmail, jiraApiToken, jiraProjectKey });
    document.getElementById("jiraBaseUrl").value = jiraBaseUrl;
    document.getElementById("jiraProjectKey").value = jiraProjectKey;
    document.querySelectorAll(".secret-toggle").forEach((toggle) => {
      document.getElementById(toggle.dataset.target).type = "password";
      toggle.textContent = "Hiện";
    });
    showMessage("Đã lưu an toàn hơn trong storage.local. Lưu ý: đây vẫn không phải secret vault.");
  } catch (error) {
    showMessage(safeErrorMessage(error), true);
  } finally {
    setBusy(button, false);
    button.textContent = originalLabel;
  }
});
