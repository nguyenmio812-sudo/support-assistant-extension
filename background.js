// background.js — MV3 service worker.
// Đây là nơi DUY NHẤT gọi ra API bên ngoài (Claude / Jira / Slack).
// Token/API key được đọc từ chrome.storage (cấu hình ở options.html).
//
// KHUYẾN NGHỊ PRODUCTION: đừng gọi thẳng Claude/Jira API bằng key cá nhân
// lưu trong extension — hãy dựng 1 backend proxy nội bộ (xem PROPOSAL.md
// mục 5) để: (1) không lộ key trong extension, (2) dùng chung issue-tracking
// giữa nhiều agent, (3) tránh rate-limit khi nhiều agent cùng poll Jira.
// Code dưới đây gọi trực tiếp để bạn chạy thử nhanh ở mức MVP/demo.

// Cho phép click icon extension để mở side panel trực tiếp (thay vì phải
// mở qua menu chuột phải). Đây là hành động của người dùng — không có gì
// tự động đọc trang cho tới khi agent bấm "Tóm tắt" bên trong side panel.
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("setPanelBehavior lỗi:", err));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => sendResponse({ error: String(err) }));
  return true; // giữ kênh async
});

async function handleMessage(message) {
  const cfg = await chrome.storage.sync.get(["claudeApiKey", "jiraBaseUrl", "jiraEmail", "jiraApiToken", "jiraProjectKey"]);

  switch (message.type) {
    case "SUMMARIZE_CONVERSATION":
      return { data: await summarizeConversation(message.payload, cfg) };
    case "DRAFT_REPLY":
      return { data: await draftReply(message.payload, cfg) };
    case "CREATE_JIRA_ISSUE":
      return { data: await createJiraIssue(message.payload, cfg) };
    case "GET_JIRA_STATUS":
      return { data: await getJiraStatus(message.payload, cfg) };
    case "GET_JIRA_TITLE":
      return { data: await getJiraTitle(message.payload, cfg) };
    default:
      return { error: "Unknown message type: " + message.type };
  }
}

async function callClaude(cfg, systemPrompt, userPrompt) {
  if (!cfg.claudeApiKey) throw new Error("Chưa cấu hình Claude API key (vào trang Cài đặt).");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.claudeApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API lỗi: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return text;
}

async function summarizeConversation(payload, cfg) {
  const { conversation, lang, replyLang } = payload;

  const systemPrompt = `Bạn là trợ lý cho agent support. Nội dung hội thoại gốc bên dưới có thể ở BẤT KỲ ngôn ngữ nào (Anh, Đức, Việt, Pháp...) — hãy đọc hiểu đúng nội dung bất kể ngôn ngữ gốc là gì. Trả lời CHỈ bằng JSON hợp lệ, không kèm markdown, theo đúng schema:
{
  "summary": string (tóm tắt vấn đề chính, đã thử gì, đang chờ gì — viết bằng ngôn ngữ ${lang}),
  "priority": "P1" | "P2" | "P3" | "P4"  (P1 = khẩn cấp nhất),
  "tags": string[] (2-4 tag ngắn gọn, ví dụ: Bug, Billing, Feature Request, Account, Integration)
}`;

  const userPrompt = `Nội dung hội thoại support (${conversation.messageCount} tin nhắn):\n\n${conversation.text}`;

  const raw = await callClaude(cfg, systemPrompt, userPrompt);
  const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  parsed.replyLang = replyLang;
  return parsed;
}

async function draftReply(data, cfg) {
  const systemPrompt = `Viết 1 câu trả lời ngắn gọn, lịch sự cho khách hàng bằng ngôn ngữ ${data.replyLang || "vi"}, dựa trên tóm tắt vấn đề. Chỉ trả về nội dung tin nhắn, không thêm giải thích.`;
  const reply = await callClaude(cfg, systemPrompt, data.summary);
  return { reply };
}

async function createJiraIssue(payload, cfg) {
  if (!cfg.jiraBaseUrl || !cfg.jiraEmail || !cfg.jiraApiToken || !cfg.jiraProjectKey) {
    throw new Error("Chưa cấu hình đủ Jira (base URL / email / API token / project key) ở trang Cài đặt.");
  }

  const auth = btoa(`${cfg.jiraEmail}:${cfg.jiraApiToken}`);
  const res = await fetch(`${cfg.jiraBaseUrl}/rest/api/3/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      fields: {
        project: { key: cfg.jiraProjectKey },
        summary: payload.title,
        description: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: payload.description }] },
            { type: "paragraph", content: [{ type: "text", text: `Nguồn: ${payload.sourceLink}` }] },
          ],
        },
        issuetype: { name: "Task" },
        labels: payload.tags || [],
      },
    }),
  });

  if (!res.ok) throw new Error(`Jira API lỗi: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { key: data.key, url: `${cfg.jiraBaseUrl}/browse/${data.key}` };
}

async function getJiraStatus(payload, cfg) {
  const match = payload.jiraLink.match(/browse\/([A-Z]+-\d+)/);
  if (!match) return { status: null };
  const key = match[1];

  const auth = btoa(`${cfg.jiraEmail}:${cfg.jiraApiToken}`);
  const res = await fetch(`${cfg.jiraBaseUrl}/rest/api/3/issue/${key}?fields=status`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) return { status: null };
  const data = await res.json();

  const statusName = data.fields?.status?.name || "";
  // Dùng statusCategory.key ("new" | "indeterminate" | "done") thay vì đoán
  // theo TÊN status — vì mỗi team Jira có thể đặt tên workflow tuỳ ý (VD:
  // "Passed", "QA Verified", "Released"...) mà vẫn được Jira xếp vào category
  // "done" chuẩn. Đoán theo tên (chỉ khớp "done"/"closed"/"resolved") là lý
  // do issue đã "Passed" nhưng vẫn hiển thị "To Do" ở bản trước.
  const categoryKey = data.fields?.status?.statusCategory?.key || "";

  let status = "todo";
  if (categoryKey === "indeterminate") status = "inprogress";
  if (categoryKey === "done") status = "done";

  return { status, statusName };
}

async function getJiraTitle(payload, cfg) {
  const match = payload.jiraLink.match(/browse\/([A-Z]+-\d+)/);
  if (!match) throw new Error("Link Jira không hợp lệ — cần đúng dạng .../browse/PROJ-123");
  const key = match[1];

  if (!cfg.jiraBaseUrl || !cfg.jiraEmail || !cfg.jiraApiToken) {
    throw new Error("Chưa cấu hình đủ Jira (base URL / email / API token) ở trang Cài đặt.");
  }

  const auth = btoa(`${cfg.jiraEmail}:${cfg.jiraApiToken}`);
  const res = await fetch(`${cfg.jiraBaseUrl}/rest/api/3/issue/${key}?fields=summary`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Jira API lỗi: ${res.status} ${await res.text()}`);
  const data = await res.json();

  return { title: data.fields?.summary || null };
}
