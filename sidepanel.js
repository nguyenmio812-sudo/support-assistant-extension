// sidepanel.js — logic cho UI. Toàn bộ gọi API thật đều đi qua background.js
// để không lộ token trong context của trang web.

const {
  cleanText,
  normalizeCrispUrl,
  normalizeJiraIssueUrl,
  safeErrorMessage,
} = SupportAssistantCommon;

function clearElement(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function createExternalLink(label, href) {
  const link = document.createElement("a");
  link.textContent = label;
  try {
    const url = new URL(href);
    const allowedHost = /(^|\.)crisp\.chat$/i.test(url.hostname) || url.hostname.endsWith(".atlassian.net");
    if (url.protocol !== "https:" || !allowedHost) throw new Error("blocked");
    link.href = url.toString();
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  } catch {
    link.removeAttribute("href");
    link.title = "Link cũ không an toàn hoặc không thuộc domain được phép.";
  }
  return link;
}

function createSmallButton(label, className, id) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ghost compact-action ${className}`;
  button.dataset.id = id;
  button.textContent = label;
  return button;
}

function showNotice(scope, message = "", type = "error") {
  const element = document.getElementById(`${scope}Notice`);
  if (!element) return;
  element.textContent = cleanText(message, 600);
  element.className = `notice${message ? ` is-${type}` : ""}`;
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

async function normalizeConfiguredJiraLink(value) {
  const { jiraBaseUrl } = await chrome.storage.local.get("jiraBaseUrl");
  return normalizeJiraIssueUrl(value, jiraBaseUrl);
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".panel").forEach((p) => {
      p.classList.remove("active");
      p.setAttribute("aria-hidden", "true");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    const panel = document.getElementById(`panel-${btn.dataset.tab}`);
    panel.classList.add("active");
    panel.setAttribute("aria-hidden", "false");
    if (btn.dataset.tab === "issues") syncJiraStatuses();
  });

  btn.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll(".tab-btn")];
    const current = tabs.indexOf(btn);
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(current + direction + tabs.length) % tabs.length];
    next.focus();
    next.click();
  });
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// ---------- TAB 1: Tóm tắt ----------

document.getElementById("summarizeBtn").addEventListener("click", async () => {
  const btn = document.getElementById("summarizeBtn");
  const originalLabel = btn.textContent;
  setBusy(btn, true);
  showNotice("summary");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      showNotice("summary", "Không tìm thấy tab đang mở.");
      return;
    }

    // Không thể inject vào các trang nội bộ của trình duyệt / Chrome Web Store
    let activeUrl;
    try { activeUrl = new URL(tab.url); } catch { activeUrl = null; }
    if (!activeUrl || activeUrl.protocol !== "https:" || !/(^|\.)crisp\.chat$/i.test(activeUrl.hostname)) {
      showNotice("summary", "Vì lý do bảo mật, extension chỉ đọc hội thoại trên domain HTTPS thuộc crisp.chat.");
      return;
    }

    btn.textContent = "Đang tải lịch sử & đọc nội dung tab...";

    // BƯỚC 1: inject content.js vào TẤT CẢ frame của tab hiện tại (kể cả
    // iframe — vì khung chat của nhiều tool support nằm trong iframe riêng).
    // CHỈ xảy ra ngay tại đây, do người dùng chủ động bấm nút.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
    });

    // BƯỚC 2: gọi hàm trích xuất trong MỌI frame, rồi chọn ra frame có nội
    // dung tốt nhất (nhiều khả năng đó chính là khung chat thật).
    const frameResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => window.__extractSupportConversation ? window.__extractSupportConversation() : null,
    });

    const validResults = frameResults
      .map((r) => r.result)
      .filter((r) => r && !r.error);

    if (validResults.length === 0) {
      showNotice("summary", "Không đọc được nội dung hội thoại. Hãy chắc chắn trang Crisp đã tải xong rồi thử lại.");
      return;
    }

    // Chọn frame có textLength lớn nhất — đại diện cho nội dung hội thoại đầy đủ nhất
    const conversation = validResults.sort((a, b) => (b.textLength || 0) - (a.textLength || 0))[0];

    if (!confirm(`Chuẩn bị gửi tối đa ${conversation.textLength || 0} ký tự từ hội thoại này tới OpenAI API sau khi che email/số điện thoại/token. Tiếp tục?`)) return;

    btn.textContent = "Đang tóm tắt (OpenAI)...";

    const lang = document.getElementById("langSelect").value;
    const replyLang = document.getElementById("replyLangSelect").value;

    const response = await chrome.runtime.sendMessage({
      type: "SUMMARIZE_CONVERSATION",
      payload: { conversation, lang, replyLang },
    });

    if (response.error) {
      showNotice("summary", response.error);
      return;
    }

    renderSummary(response.data, tab.url, conversation);
  } catch (err) {
    showNotice("summary", safeErrorMessage(err));
  } finally {
    setBusy(btn, false);
    btn.textContent = originalLabel;
  }
});

function renderSummary(data, sourceUrl, debugInfo) {
  document.getElementById("summaryResult").style.display = "block";
  document.getElementById("summaryText").textContent = data.summary;

  // Hiển thị nguồn đã đọc để agent xác minh đúng conversation (VD: đúng
  // "Sabine Schmid" chứ không phải hội thoại khác) trước khi tin tưởng tóm tắt.
  const debugEl = document.getElementById("debugInfo");
  if (debugEl) {
    const frameNote = debugInfo.isTopFrame ? "" : " (đọc từ iframe)";
    const reasonMap = {
      "reached-max-resolved-cycles": "đủ 2 mốc resolved",
      "no-more-history": "hết lịch sử",
      "max-iterations": "chạm giới hạn cuộn",
      "no-container": "không có khung cuộn",
    };
    const scrollNote = debugInfo.scrollInfo?.scrolled
      ? ` · đã cuộn ${debugInfo.scrollInfo.iterations} lần (${reasonMap[debugInfo.scrollInfo.stoppedReason] || debugInfo.scrollInfo.stoppedReason})`
      : "";
    debugEl.textContent = `Nguồn đã đọc: "${debugInfo.title || sourceUrl}"${frameNote} · ${debugInfo.messageCount} dòng${scrollNote} · ${debugInfo.method}`;
    debugEl.title = debugInfo.url;
  }

  const p = document.getElementById("priorityLabel");
  clearElement(p);
  p.append("Priority: ");
  const priority = document.createElement("span");
  priority.className = `priority-${["P1", "P2", "P3", "P4"].includes(data.priority) ? data.priority : "P4"}`;
  priority.textContent = data.priority;
  p.appendChild(priority);

  const tagsEl = document.getElementById("tagsContainer");
  clearElement(tagsEl);
  (data.tags || []).forEach((t) => {
    const span = document.createElement("span");
    span.className = "chip";
    span.textContent = t;
    tagsEl.appendChild(span);
  });

  const actionsEl = document.getElementById("suggestedActions");
  clearElement(actionsEl);

  const actions = [
    { label: "Thêm conversation vào Issue Tracking", action: () => addIssue({ sourceLink: sourceUrl, title: data.summary.slice(0, 80) }) },
    { label: `Soạn trả lời khách (${data.replyLang || "vi"})`, action: (evt) => draftReply(data, evt.currentTarget) },
  ];

  actions.forEach((a) => {
    const b = document.createElement("button");
    b.textContent = a.label;
    const arrow = document.createElement("span");
    arrow.textContent = "›";
    b.appendChild(arrow);
    b.addEventListener("click", a.action);
    actionsEl.appendChild(b);
  });

  // Fire-and-forget — không chờ Jira search xong mới hiện phần còn lại của tóm tắt.
  renderRelatedIssues(data.tags, data.summary, sourceUrl);

  // Ẩn khung gợi ý trả lời cũ (nếu có từ lần tóm tắt trước) khi tóm tắt mới
  document.getElementById("replyDraftSection").style.display = "none";
  // Ẩn gợi ý issue liên quan cũ — tránh hiện nhầm kết quả của lần tóm tắt trước
  // trong lúc chờ kết quả mới trả về.
  document.getElementById("relatedIssuesSection").style.display = "none";
}

async function renderRelatedIssues(tags, summaryText, sourceUrl) {
  const section = document.getElementById("relatedIssuesSection");
  const container = document.getElementById("relatedIssuesContainer");

  if (!tags || tags.length === 0) return;

  const response = await chrome.runtime.sendMessage({ type: "SEARCH_RELATED_ISSUES", payload: { tags, summaryText } });
  const results = response?.data?.results || [];
  if (results.length === 0) return; // không hiện "không tìm thấy gì" — tránh gây rối UI

  const trackedIssues = await getIssues();
  clearElement(container);

  results.forEach((result) => {
    const alreadyTracked = trackedIssues.some((issue) => issue.jiraLink === result.url);
    const shortTitle = result.title.length > 50 ? result.title.slice(0, 50) + "…" : result.title;

    const row = document.createElement("div");
    row.className = "jira-result-row";
    const description = document.createElement("span");
    description.className = "jira-result-description";
    description.append(`[${cleanText(result.statusName || "?", 100)}] `);
    description.appendChild(createExternalLink(cleanText(result.key, 64), result.url));
    description.append(`: ${cleanText(shortTitle, 80)}`);
    row.appendChild(description);

    if (alreadyTracked) {
      const span = document.createElement("span");
      span.className = "provider-badge";
      span.textContent = "Đã theo dõi";
      row.appendChild(span);
    } else {
      const btn = document.createElement("button");
      btn.className = "secondary compact-action";
      btn.textContent = "Thêm";
      btn.addEventListener("click", async () => {
        setBusy(btn, true);
        await addIssue({ title: result.title, jiraLink: result.url, sourceLink: sourceUrl });
        btn.textContent = "Đã thêm";
      });
      row.appendChild(btn);
    }

    container.appendChild(row);
  });

  section.style.display = "block";
}

// Giữ lại data gốc của lần tóm tắt gần nhất để nút "Tạo lại câu trả lời" có
// thể gửi lại đúng context, kèm agentHint bổ sung, mà không cần tóm tắt lại.
let lastSummaryData = null;

async function draftReply(data, btn) {
  lastSummaryData = data;
  const originalText = btn?.textContent;
  if (btn) { setBusy(btn, true); btn.textContent = "Đang soạn gợi ý..."; }

  try {
    const response = await chrome.runtime.sendMessage({ type: "DRAFT_REPLY", payload: data });
    if (response.error) {
      showNotice("summary", response.error);
      return;
    }

    // Hiển thị vào khung để agent REVIEW/CHỈNH SỬA trước, không tự copy ngay.
    const section = document.getElementById("replyDraftSection");
    const textarea = document.getElementById("replyDraftText");
    textarea.value = response.data.reply;
    section.style.display = "block";
    section.scrollIntoView({ behavior: "smooth", block: "nearest" });
    textarea.focus();
  } finally {
    if (btn) { setBusy(btn, false); btn.textContent = originalText; }
  }
}

document.getElementById("copyReplyBtn").addEventListener("click", () => {
  const textarea = document.getElementById("replyDraftText");
  navigator.clipboard.writeText(textarea.value);
  const btn = document.getElementById("copyReplyBtn");
  const original = btn.textContent;
  btn.textContent = "Đã copy";
  showNotice("summary", "Đã copy bản nháp vào clipboard.", "success");
  setTimeout(() => { btn.textContent = original; }, 1500);
});

document.getElementById("regenerateReplyBtn").addEventListener("click", async (e) => {
  if (!lastSummaryData) return;
  const btn = e.currentTarget;
  const hintValue = document.getElementById("replyHintInput").value.trim();

  const original = btn.textContent;
  setBusy(btn, true);
  btn.textContent = "Đang tạo lại...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "DRAFT_REPLY",
      payload: { ...lastSummaryData, agentHint: hintValue },
    });
    if (response.error) {
      showNotice("summary", response.error);
      return;
    }
    // Không xoá #replyHintInput — agent có thể bấm lại nhiều lần với ý bổ sung khác.
    document.getElementById("replyDraftText").value = response.data.reply;
  } finally {
    setBusy(btn, false);
    btn.textContent = original;
  }
});

// ---------- TAB 2: Issue Tracking ----------

document.getElementById("addCurrentBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await addIssue({ sourceLink: tab.url, title: "(chưa có tiêu đề — sửa thủ công)" });
  renderIssuesList();
  showNotice("issues", "Đã thêm tab hiện tại vào danh sách theo dõi.", "success");
});

document.getElementById("syncAllBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const original = btn.textContent;
  setBusy(btn, true);
  btn.textContent = "Đang đồng bộ...";
  try {
    await syncJiraStatuses();
  } finally {
    setBusy(btn, false);
    btn.textContent = original;
  }
});

document.getElementById("myUntrackedIssuesBtn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  const original = btn.textContent;
  setBusy(btn, true);
  btn.textContent = "Đang tải...";

  try {
    const trackedJiraLinks = (await getIssues()).map((i) => i.jiraLink).filter(Boolean);
    const response = await chrome.runtime.sendMessage({ type: "GET_MY_UNTRACKED_ISSUES", payload: { trackedJiraLinks } });
    if (response?.data?.error) showNotice("issues", response.data.error);
    renderJiraSearchResults(response?.data?.results || []);
  } finally {
    setBusy(btn, false);
    btn.textContent = original;
  }
});

async function runKeywordSearch() {
  const input = document.getElementById("keywordSearchInput");
  const keyword = input.value.trim();
  if (!keyword) return;

  const btn = document.getElementById("keywordSearchBtn");
  const original = btn.textContent;
  setBusy(btn, true);
  btn.textContent = "Đang tìm...";

  try {
    const trackedJiraLinks = (await getIssues()).map((i) => i.jiraLink).filter(Boolean);
    const response = await chrome.runtime.sendMessage({ type: "SEARCH_JIRA_BY_KEYWORD", payload: { keyword, trackedJiraLinks } });
    if (response?.data?.error) showNotice("issues", response.data.error);
    renderJiraSearchResults(response?.data?.results || []);
  } finally {
    setBusy(btn, false);
    btn.textContent = original;
  }
}

document.getElementById("keywordSearchBtn").addEventListener("click", runKeywordSearch);
document.getElementById("keywordSearchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runKeywordSearch();
});

// Dùng chung cho cả "Issue tôi đang follow" và tìm theo từ khoá — cùng 1 khu
// vực hiển thị, cùng logic render/thêm issue, để không lặp code giữa 2 tính năng.
function renderJiraSearchResults(results) {
  const section = document.getElementById("jiraSearchSection");
  const container = document.getElementById("jiraSearchContainer");
  clearElement(container);

  if (results.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Không tìm thấy issue nào.";
    container.appendChild(empty);
  } else {
    results.forEach((result) => {
      const row = document.createElement("div");
      row.className = "jira-result-row";
      const description = document.createElement("span");
      description.className = "jira-result-description";
      description.append(`[${cleanText(result.statusName || "?", 100)}] `);
      description.appendChild(createExternalLink(cleanText(result.key, 64), result.url));
      description.append(`: ${cleanText(result.title, 500)}`);
      row.appendChild(description);

      const addBtn = document.createElement("button");
      addBtn.className = "secondary compact-action";
      addBtn.textContent = "Thêm";
      addBtn.addEventListener("click", async () => {
        setBusy(addBtn, true);
        await addIssue({ title: result.title, jiraLink: result.url, sourceLink: "" });
        addBtn.textContent = "Đã thêm";
      });
      row.appendChild(addBtn);
      container.appendChild(row);
    });
  }

  section.style.display = "block";
}

document.getElementById("jiraSearchCloseBtn").addEventListener("click", () => {
  document.getElementById("jiraSearchSection").style.display = "none";
  renderIssuesList();
});

// Đóng danh sách khi click ra ngoài — vẫn cập nhật danh sách chính để phản
// ánh những issue vừa được thêm liên tiếp trong lúc mở. Không đóng khi click
// vào chính các nút/ô mở ra khu vực này.
document.addEventListener("click", (e) => {
  const section = document.getElementById("jiraSearchSection");
  if (section.style.display === "none") return;
  const triggers = ["myUntrackedIssuesBtn", "keywordSearchBtn", "keywordSearchInput"].map((id) => document.getElementById(id));
  if (section.contains(e.target) || triggers.includes(e.target)) return;
  section.style.display = "none";
  renderIssuesList();
});

document.getElementById("toggleManualFormBtn").addEventListener("click", () => {
  const form = document.getElementById("manualForm");
  const isHidden = form.style.display === "none";
  form.style.display = isHidden ? "block" : "none";
  if (isHidden) document.getElementById("manualCrispLink").focus();
});

document.getElementById("manualCancelBtn").addEventListener("click", () => {
  document.getElementById("manualForm").style.display = "none";
  document.getElementById("manualCrispLink").value = "";
  document.getElementById("manualJiraLink").value = "";
});

document.getElementById("manualSaveBtn").addEventListener("click", async () => {
  let sourceLink = document.getElementById("manualCrispLink").value.trim();
  let jiraLink = document.getElementById("manualJiraLink").value.trim();

  if (!sourceLink && !jiraLink) {
    showNotice("issues", "Vui lòng nhập ít nhất một link Crisp hoặc Jira.");
    return;
  }

  // Tự nhận diện nếu 2 ô bị nhập NGƯỢC (VD: dán link Jira vào ô Crisp và
  // ngược lại — rất dễ xảy ra vì 2 ô trống trông giống nhau) và tự hoán đổi
  // lại, thay vì bắt lỗi "link không hợp lệ" một cách khó hiểu.
  const looksLikeJira = (v) => /atlassian\.net\/browse\//i.test(v);
  const looksLikeCrisp = (v) => /crisp\.chat/i.test(v);

  if (looksLikeJira(sourceLink) && looksLikeCrisp(jiraLink)) {
    [sourceLink, jiraLink] = [jiraLink, sourceLink];
    showNotice("issues", "Đã phát hiện hai link bị nhập ngược và tự hoán đổi trước khi lưu.", "success");
  }

  try {
    if (sourceLink) sourceLink = normalizeCrispUrl(sourceLink);
    if (jiraLink) jiraLink = await normalizeConfiguredJiraLink(jiraLink);
  } catch (error) {
    showNotice("issues", safeErrorMessage(error));
    return;
  }

  const btn = document.getElementById("manualSaveBtn");
  const originalLabel = btn.textContent;
  setBusy(btn, true);
  btn.textContent = "Đang lấy tiêu đề...";

  try {
    const { title, error } = await resolveIssueTitle({ sourceLink, jiraLink });
    if (error) {
      showNotice("issues", `Không tự lấy được tiêu đề: ${error}. Issue vẫn được lưu và có thể đồng bộ lại sau.`);
    }
    await addIssue({ title, sourceLink, jiraLink });
    document.getElementById("manualCancelBtn").click(); // reset form + ẩn
    renderIssuesList();
    if (!error) showNotice("issues", "Đã lưu issue vào danh sách theo dõi.", "success");
  } finally {
    setBusy(btn, false);
    btn.textContent = originalLabel;
  }
});

// Tự động xác định tiêu đề issue: ưu tiên lấy summary từ Jira (nếu có link
// Jira, dùng luôn Jira REST API đã tích hợp sẵn ở background.js — không cần
// thêm backend gì mới). Nếu không có link Jira, thử lấy title của tab Crisp
// đang mở khớp đúng link đó (nếu tab vẫn đang mở trong trình duyệt).
// Trả về { title, error } — error khác null nghĩa là có lỗi thật sự (VD:
// chưa cấu hình Jira, sai link, 401 Unauthorized...) cần báo cho agent biết,
// KHÔNG âm thầm nuốt lỗi như bản trước.
async function resolveIssueTitle({ sourceLink, jiraLink }) {
  if (jiraLink) {
    const res = await chrome.runtime.sendMessage({ type: "GET_JIRA_TITLE", payload: { jiraLink } });
    if (res?.data?.title) return { title: res.data.title, error: null };
    if (res?.error) return { title: "(chưa có tiêu đề — sửa thủ công)", error: res.error };
  }

  if (sourceLink) {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.url === sourceLink && activeTab.title) return { title: cleanText(activeTab.title, 500), error: null };
    } catch (e) {
      /* ignore, dùng fallback bên dưới */
    }
  }

  return { title: "(chưa có tiêu đề — sửa thủ công)", error: null };
}

async function getIssues() {
  // Dùng storage.local thay vì storage.sync — sync có giới hạn rất nhỏ
  // (~8KB/item), rất dễ âm thầm lưu thất bại (không báo lỗi gì) khi danh
  // sách issue lớn dần, gây mất dữ liệu như bạn gặp phải. storage.local có
  // quota lớn hơn nhiều (mặc định 5MB, không giới hạn theo từng item) và vẫn
  // BỀN VỮNG qua các lần tắt/mở trình duyệt — chỉ khác là không đồng bộ giữa
  // các máy (điều này vốn đã không đáng tin cậy với sync do giới hạn trên).
  const localResult = await chrome.storage.local.get("issues");
  if (localResult.issues && localResult.issues.length > 0) return localResult.issues;

  // MIGRATION: nếu đang có issue cũ lưu ở storage.sync (từ bản trước khi
  // chuyển sang local) mà local chưa có gì, tự động chuyển dữ liệu qua để
  // KHÔNG làm mất issue đã lưu trước đó.
  try {
    const syncResult = await chrome.storage.sync.get("issues");
    if (syncResult.issues && syncResult.issues.length > 0) {
      await chrome.storage.local.set({ issues: syncResult.issues });
      return syncResult.issues;
    }
  } catch (e) {
    /* ignore, không có gì để migrate */
  }

  return [];
}

async function saveIssues(issues) {
  await chrome.storage.local.set({ issues });
}

async function addIssue(partial) {
  const issues = await getIssues();
  issues.unshift({
    id: crypto.randomUUID(),
    title: cleanText(partial.title, 500) || "(chưa có tiêu đề)",
    sourceLink: cleanText(partial.sourceLink, 2048),
    jiraLink: cleanText(partial.jiraLink, 2048),
    slackLink: cleanText(partial.slackLink, 2048),
    status: partial.status || "todo", // todo | inprogress | done
    reminderSent: false,
    reportedToCustomer: false,
    priority: partial.priority || false,
    createdAt: Date.now(),
  });
  await saveIssues(issues);
}

// Tính số ngày đã mở kể từ khi issue được tạo trên Jira (jiraCreatedAt).
// Trả về null nếu issue chưa từng sync với Jira nên chưa có mốc thời gian này.
function issueAgeDays(issue) {
  if (!issue.jiraCreatedAt) return null;
  return Math.floor((Date.now() - new Date(issue.jiraCreatedAt).getTime()) / (24 * 60 * 60 * 1000));
}

// Gọi GET_JIRA_STATUS cho 1 issue và cập nhật status/statusName/jiraSyncError/
// jiraCreatedAt ngay trên object issue truyền vào (không saveIssues — gọi nơi
// dùng tự lưu). Tách riêng để dùng chung giữa nút resync-issue và edit-jira.
async function syncIssueJiraStatus(target) {
  const statusRes = await chrome.runtime.sendMessage({ type: "GET_JIRA_STATUS", payload: { jiraLink: target.jiraLink } });
  if (statusRes?.data?.status) {
    target.status = statusRes.data.status;
    target.statusName = statusRes.data.statusName || null;
    target.jiraSyncError = null;
  } else if (statusRes?.error) {
    target.jiraSyncError = statusRes.error;
  }
  if (statusRes?.data?.created) target.jiraCreatedAt = statusRes.data.created;
}

function buildIssueCard(issue) {
  const card = document.createElement("div");
  card.className = "issue-card" + (issue.priority ? " issue-card-priority" : "");

  const statusClass = { todo: "status-todo", inprogress: "status-inprogress", done: "status-done" }[issue.status] || "status-todo";
  const statusLabel = cleanText(issue.statusName || { todo: "To Do", inprogress: "In Progress", done: "Done" }[issue.status] || issue.status, 100);
  const ageDays = issueAgeDays(issue);

  const header = document.createElement("div");
  header.className = "issue-header";
  const title = document.createElement("strong");
  title.className = "issue-title";
  title.textContent = issue.title === "(chưa có tiêu đề — sửa thủ công)" ? "Chưa có tiêu đề" : cleanText(issue.title, 500);
  const controls = document.createElement("span");
  controls.className = "issue-controls";
  const badge = document.createElement("span");
  badge.className = `status-badge ${statusClass}`;
  badge.textContent = statusLabel;
  controls.appendChild(badge);

  const priorityLabel = document.createElement("label");
  priorityLabel.className = "check-control";
  priorityLabel.title = "Đánh dấu ưu tiên";
  const priorityCheckbox = document.createElement("input");
  priorityCheckbox.type = "checkbox";
  priorityCheckbox.className = "priority-checkbox";
  priorityCheckbox.dataset.id = issue.id;
  priorityCheckbox.checked = Boolean(issue.priority);
  priorityLabel.append(priorityCheckbox, " Ưu tiên");
  if (issue.jiraLink) {
    const resync = createSmallButton("Sync", "resync-issue", issue.id);
    resync.title = "Đồng bộ lại tiêu đề/status từ Jira";
    controls.appendChild(resync);
  }
  header.append(title, controls);
  card.appendChild(header);

  const meta = document.createElement("div");
  meta.className = "meta";
  if (issue.sourceLink) {
    meta.append(createExternalLink("Nguồn", issue.sourceLink), createSmallButton("Sửa", "edit-source", issue.id));
  } else {
    meta.appendChild(createSmallButton("Thêm link Crisp", "edit-source", issue.id));
  }
  meta.append(" · ");
  if (issue.jiraLink) {
    meta.append(createExternalLink("Jira", issue.jiraLink), createSmallButton("Sửa", "edit-jira", issue.id));
  } else {
    meta.appendChild(createSmallButton("Thêm link Jira", "edit-jira", issue.id));
  }
  meta.append(" · ", createSmallButton("Sửa tiêu đề", "edit-title", issue.id));
  card.appendChild(meta);

  if (ageDays !== null && Number.isFinite(ageDays)) {
    const age = document.createElement("div");
    age.className = "issue-age";
    age.textContent = `Đã mở ${Math.max(0, ageDays)} ngày`;
    card.appendChild(age);
  }
  if (issue.jiraSyncError) {
    const error = document.createElement("div");
    error.className = "issue-error";
    error.textContent = `Lỗi đồng bộ Jira: ${cleanText(issue.jiraSyncError, 500)}`;
    card.appendChild(error);
  }
  if (issue.status === "done" && !issue.reportedToCustomer) {
    const reminder = document.createElement("div");
    reminder.className = "reminder-banner";
    reminder.textContent = `Jira đã ${statusLabel || "Done"}. Đã báo khách chưa?`;
    card.appendChild(reminder);
  }

  const footer = document.createElement("div");
  footer.className = "issue-footer";
  const reportedLabel = document.createElement("label");
  reportedLabel.className = "check-control";
  const reportedCheckbox = document.createElement("input");
  reportedCheckbox.type = "checkbox";
  reportedCheckbox.className = "mark-reported-checkbox";
  reportedCheckbox.dataset.id = issue.id;
  reportedCheckbox.checked = Boolean(issue.reportedToCustomer);
  reportedLabel.append(reportedCheckbox, " Đã báo khách");
  const flags = document.createElement("span");
  flags.className = "issue-flags";
  flags.append(priorityLabel, reportedLabel);
  const removeButton = createSmallButton("Xóa", "remove-issue danger-action", issue.id);
  footer.append(flags, removeButton);
  card.appendChild(footer);
  return card;
}

// CHỈ đọc từ storage.local và render DOM — không gọi Jira API. Dùng cho mọi
// thao tác cục bộ (tick priority/đã báo khách, xoá, sửa tiêu đề, link jira
// thủ công) để không phải chờ đồng bộ lại toàn bộ issue mỗi lần bấm.
async function renderIssuesList() {
  const issues = await getIssues();
  const list = document.getElementById("issuesList");
  clearElement(list);
  const activeCount = issues.filter((issue) => !issue.reportedToCustomer).length;
  const count = document.getElementById("issuesCount");
  count.textContent = String(activeCount);
  count.setAttribute("aria-label", `${activeCount} issue đang xử lý`);

  if (issues.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Chưa có issue nào. Thêm tab hiện tại hoặc tìm issue Jira để bắt đầu theo dõi.";
    list.appendChild(empty);
    return;
  }

  // Issue đã báo khách coi như đã xong việc — đẩy hết xuống cuối vào 1 khu
  // riêng (thu gọn mặc định) để danh sách chính chỉ còn việc đang cần xử lý.
  const activeIssues = issues.filter((i) => !i.reportedToCustomer);
  const reportedIssues = issues.filter((i) => i.reportedToCustomer);

  // Trong nhóm đang xử lý: tách tiếp issue ưu tiên lên trên. Giữ nguyên thứ tự
  // tương đối trong từng nhóm (không sort lại theo tiêu chí khác).
  const priorityIssues = activeIssues.filter((i) => i.priority);
  const otherIssues = activeIssues.filter((i) => !i.priority);

  if (priorityIssues.length > 0) {
    const heading = document.createElement("div");
    heading.className = "issue-section-heading";
    heading.textContent = `Ưu tiên (${priorityIssues.length})`;
    list.appendChild(heading);
    priorityIssues.forEach((issue) => list.appendChild(buildIssueCard(issue)));
  }

  if (otherIssues.length > 0) {
    const heading = document.createElement("div");
    heading.className = "issue-section-heading";
    heading.textContent = `Đang xử lý (${otherIssues.length})`;
    list.appendChild(heading);
    otherIssues.forEach((issue) => list.appendChild(buildIssueCard(issue)));
  }

  if (reportedIssues.length > 0) {
    const details = document.createElement("details");
    details.className = "reported-section";
    const summary = document.createElement("summary");
    summary.textContent = `Đã báo khách (${reportedIssues.length})`;
    details.appendChild(summary);
    reportedIssues.forEach((issue) => details.appendChild(buildIssueCard(issue)));
    list.appendChild(details);
  }

  list.querySelectorAll(".resync-issue").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.id;
      e.currentTarget.textContent = "…";
      const issues = await getIssues();
      const target = issues.find((i) => i.id === id);
      if (!target) return;

      // Tự sửa nếu issue này đã lỡ được lưu với 2 link bị NGƯỢC từ trước
      // (VD: jiraLink đang thực ra là link Crisp) — xảy ra với issue tạo
      // trước khi có auto-swap ở form thêm thủ công.
      const looksLikeJira = (v) => /atlassian\.net\/browse\//i.test(v || "");
      const looksLikeCrisp = (v) => /crisp\.chat/i.test(v || "");
      if (looksLikeCrisp(target.jiraLink) && looksLikeJira(target.sourceLink)) {
        [target.sourceLink, target.jiraLink] = [target.jiraLink, target.sourceLink];
      }

      // Đồng bộ status
      await syncIssueJiraStatus(target);

      // Nếu tiêu đề vẫn đang là placeholder, thử lấy lại luôn
      if (target.title === "(chưa có tiêu đề — sửa thủ công)") {
        const { title, error } = await resolveIssueTitle({ sourceLink: target.sourceLink, jiraLink: target.jiraLink });
        if (title && title !== "(chưa có tiêu đề — sửa thủ công)") target.title = title;
        if (error) target.jiraSyncError = error;
      }

      await saveIssues(issues);
      renderIssuesList();
    })
  );

  list.querySelectorAll(".edit-title").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.id;
      const issues = await getIssues();
      const target = issues.find((i) => i.id === id);
      if (!target) return;
      const newTitle = prompt("Sửa tiêu đề issue:", target.title === "(chưa có tiêu đề — sửa thủ công)" ? "" : target.title);
      if (newTitle === null) return; // huỷ
      target.title = newTitle.trim() || "(chưa có tiêu đề — sửa thủ công)";
      await saveIssues(issues);
      renderIssuesList();
    })
  );

  list.querySelectorAll(".remove-issue").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const issues = (await getIssues()).filter((i) => i.id !== e.target.dataset.id);
      await saveIssues(issues);
      renderIssuesList();
    })
  );

  // Checkbox đã báo khách — agent có thể tự tick/bỏ tick BẤT KỲ LÚC NÀO, không
  // chỉ khi banner nhắc xuất hiện (VD: agent đã báo trước cả khi Jira cập nhật status).
  list.querySelectorAll(".mark-reported-checkbox").forEach((cb) =>
    cb.addEventListener("change", async (e) => {
      const issues = await getIssues();
      const target = issues.find((i) => i.id === e.target.dataset.id);
      if (target) target.reportedToCustomer = e.target.checked;
      await saveIssues(issues);
      renderIssuesList();
    })
  );

  // Checkbox ưu tiên — tick/bỏ tick xong render lại ngay để card tự nhảy sang
  // đúng section (⭐ Ưu tiên / Khác) theo đúng trạng thái mới.
  list.querySelectorAll(".priority-checkbox").forEach((cb) =>
    cb.addEventListener("change", async (e) => {
      const issues = await getIssues();
      const target = issues.find((i) => i.id === e.target.dataset.id);
      if (target) target.priority = e.target.checked;
      await saveIssues(issues);
      renderIssuesList();
    })
  );

  // Sửa/thêm link Crisp — dùng chung 1 nút (chỉ khác label) cho cả 2 trường
  // hợp thêm lần đầu và sửa lại link đã có.
  list.querySelectorAll(".edit-source").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.id;
      const issues = await getIssues();
      const target = issues.find((i) => i.id === id);
      if (!target) return;
      const newLink = prompt("Sửa link Crisp:", target.sourceLink || "");
      if (newLink === null) return; // huỷ
      try {
        target.sourceLink = newLink.trim() ? normalizeCrispUrl(newLink) : "";
      } catch (error) {
        showNotice("issues", safeErrorMessage(error));
        return;
      }
      await saveIssues(issues);
      renderIssuesList();
    })
  );

  // Sửa/thêm link Jira — dùng chung 1 nút, thay cho "link-jira" cũ (chỉ thêm
  // được lúc rỗng). Nếu đổi sang 1 link Jira mới khác link cũ, đồng bộ luôn
  // status/statusName thay vì đợi lần resync tiếp theo.
  list.querySelectorAll(".edit-jira").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.id;
      const issues = await getIssues();
      const target = issues.find((i) => i.id === id);
      if (!target) return;
      const newLink = prompt("Sửa link Jira:", target.jiraLink || "");
      if (newLink === null) return; // huỷ
      let trimmed = "";
      try {
        trimmed = newLink.trim() ? await normalizeConfiguredJiraLink(newLink) : "";
      } catch (error) {
        showNotice("issues", safeErrorMessage(error));
        return;
      }
      const oldLink = target.jiraLink;
      target.jiraLink = trimmed;
      if (trimmed && trimmed !== oldLink) {
        await syncIssueJiraStatus(target);
      }
      await saveIssues(issues);
      renderIssuesList();
    })
  );
}

// Giới hạn số request Jira đồng thời để giảm nguy cơ rate limit.
async function syncJiraStatuses() {
  const issues = await getIssues();
  const pending = issues.filter((issue) => issue.jiraLink);
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const issue = pending[cursor++];
      const res = await chrome.runtime.sendMessage({ type: "GET_JIRA_STATUS", payload: { jiraLink: issue.jiraLink } });
      if (res?.data?.status) {
        issue.status = res.data.status;
        if (res.data.statusName) issue.statusName = res.data.statusName; // tên thật trên Jira, VD: "Passed"
        issue.jiraSyncError = null;
      } else if (res?.error) {
        issue.jiraSyncError = res.error;
      } else if (res?.data?.status == null) {
        // Gọi API thành công nhưng không trích được status (VD: sai định dạng
        // link Jira nên không tách được issue key, hoặc issue không tồn tại)
        issue.jiraSyncError = "Không lấy được status. Kiểm tra lại link Jira có đúng dạng .../browse/PROJ-123 không.";
      }
      // Chỉ ghi đè khi có giá trị mới — không xoá mốc thời gian cũ nếu lần sync này lỗi.
      if (res?.data?.created) issue.jiraCreatedAt = res.data.created;
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()));

  await saveIssues(issues);
  await renderIssuesList();
}

renderIssuesList();
