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
    case "SEARCH_RELATED_ISSUES":
      return { data: await searchRelatedIssues(message.payload, cfg) };
    case "GET_MY_UNTRACKED_ISSUES":
      return { data: await getMyUntrackedIssues(message.payload, cfg) };
    case "SEARCH_JIRA_BY_KEYWORD":
      return { data: await searchJiraByKeyword(message.payload, cfg) };
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
  let systemPrompt = `Viết 1 câu trả lời ngắn gọn, lịch sự cho khách hàng bằng ngôn ngữ ${data.replyLang || "vi"}, dựa trên tóm tắt vấn đề. Chỉ trả về nội dung tin nhắn, không thêm giải thích.`;
  if (data.agentHint) {
    systemPrompt += `\nLưu ý bổ sung từ agent, PHẢI đưa vào câu trả lời: ${data.agentHint}`;
  }
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
  const res = await fetch(`${cfg.jiraBaseUrl}/rest/api/3/issue/${key}?fields=status,created`, {
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

  return { status, statusName, created: data.fields?.created || null };
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

// Gợi ý issue Jira liên quan bằng JQL text search (không cần Rovo/AI search).
// KHÔNG throw ra ngoài — JQL sai cú pháp hay Jira chưa cấu hình không được
// làm vỡ luồng tóm tắt, chỉ nên âm thầm không hiện gợi ý.
async function searchRelatedIssues(payload, cfg) {
  if (!cfg.jiraBaseUrl || !cfg.jiraEmail || !cfg.jiraApiToken || !cfg.jiraProjectKey) {
    return { results: [], error: "Chưa cấu hình đủ Jira" };
  }

  try {
    const tags = (payload.tags || []).slice(0, 3);
    if (tags.length === 0) return { results: [] };

    // Dùng tag đầu tiên làm từ khoá chính; escape dấu ngoặc kép để không phá JQL.
    const primaryTag = tags[0].replace(/"/g, '\\"');
    const jql = `project = "${cfg.jiraProjectKey}" AND text ~ "${primaryTag}" ORDER BY updated DESC`;

    const auth = btoa(`${cfg.jiraEmail}:${cfg.jiraApiToken}`);
    // Jira đã gỡ /search cũ (410), dùng /search/jql — xem https://developer.atlassian.com/changelog/#CHANGE-2046
    const res = await fetch(`${cfg.jiraBaseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,status&maxResults=5`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) throw new Error(`Jira API lỗi: ${res.status} ${await res.text()}`);
    const data = await res.json();

    return {
      results: (data.issues || []).map((i) => ({
        key: i.key,
        title: i.fields.summary,
        url: `${cfg.jiraBaseUrl}/browse/${i.key}`,
        statusName: i.fields.status?.name,
      })),
    };
  } catch (err) {
    return { results: [], error: String(err) };
  }
}

// Gọi Jira search API với 1 JQL cho sẵn, trả về issue đã lọc bỏ những cái đã
// có trong trackedJiraLinks. Dùng chung cho getMyUntrackedIssues và
// searchJiraByKeyword — 2 hàm này chỉ khác nhau ở JQL/maxResults.
async function runJiraSearch(jql, maxResults, trackedJiraLinks, cfg) {
  const auth = btoa(`${cfg.jiraEmail}:${cfg.jiraApiToken}`);
  // Jira đã gỡ /search cũ (410), dùng /search/jql — xem https://developer.atlassian.com/changelog/#CHANGE-2046
  const res = await fetch(`${cfg.jiraBaseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,status&maxResults=${maxResults}`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) throw new Error(`Jira API lỗi: ${res.status} ${await res.text()}`);
  const data = await res.json();

  const tracked = new Set(trackedJiraLinks || []);
  return (data.issues || [])
    .map((i) => ({
      key: i.key,
      title: i.fields.summary,
      url: `${cfg.jiraBaseUrl}/browse/${i.key}`,
      statusName: i.fields.status?.name,
    }))
    .filter((issue) => !tracked.has(issue.url));
}

// Issue đang assign/watch cho chính agent (theo Jira account đăng nhập bằng
// jiraEmail/jiraApiToken) nhưng CHƯA có trong Issue Tracking của extension.
async function getMyUntrackedIssues(payload, cfg) {
  if (!cfg.jiraBaseUrl || !cfg.jiraEmail || !cfg.jiraApiToken || !cfg.jiraProjectKey) {
    return { results: [], error: "Chưa cấu hình đủ Jira (base URL / email / API token / project key) ở trang Cài đặt." };
  }

  try {
    const jql = `project = "${cfg.jiraProjectKey}" AND (assignee = currentUser() OR watcher = currentUser()) AND statusCategory != Done ORDER BY updated DESC`;
    const results = await runJiraSearch(jql, 20, payload.trackedJiraLinks, cfg);
    return { results };
  } catch (err) {
    return { results: [], error: String(err) };
  }
}

// Tìm issue Jira theo từ khoá tự do (agent gõ tay), loại bỏ issue đã có trong
// Issue Tracking để không gợi ý trùng.
async function searchJiraByKeyword(payload, cfg) {
  if (!cfg.jiraBaseUrl || !cfg.jiraEmail || !cfg.jiraApiToken || !cfg.jiraProjectKey) {
    return { results: [], error: "Chưa cấu hình đủ Jira (base URL / email / API token / project key) ở trang Cài đặt." };
  }

  try {
    const keyword = (payload.keyword || "").replace(/"/g, '\\"');
    const jql = `project = "${cfg.jiraProjectKey}" AND text ~ "${keyword}" ORDER BY updated DESC`;
    const results = await runJiraSearch(jql, 10, payload.trackedJiraLinks, cfg);
    return { results };
  } catch (err) {
    return { results: [], error: String(err) };
  }
}
