// sidepanel.js — logic cho UI. Toàn bộ gọi API thật đều đi qua background.js
// để không lộ token trong context của trang web.

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "issues") renderIssues();
  });
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// ---------- TAB 1: Tóm tắt ----------

document.getElementById("summarizeBtn").addEventListener("click", async () => {
  const btn = document.getElementById("summarizeBtn");
  const originalLabel = btn.textContent;
  btn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.id) {
      alert("Không tìm thấy tab đang mở.");
      return;
    }

    // Không thể inject vào các trang nội bộ của trình duyệt / Chrome Web Store
    const blockedPrefixes = ["chrome://", "edge://", "chrome-extension://", "about:", "https://chrome.google.com/webstore"];
    if (blockedPrefixes.some((p) => tab.url?.startsWith(p))) {
      alert("Không thể đọc nội dung của trang hệ thống này. Hãy mở tab chứa cuộc trò chuyện support rồi thử lại.");
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
      alert("Không đọc được nội dung hội thoại ở bất kỳ frame nào trong tab này. Hãy chắc chắn trang đã tải xong nội dung hội thoại rồi thử lại.");
      return;
    }

    // Chọn frame có textLength lớn nhất — đại diện cho nội dung hội thoại đầy đủ nhất
    const conversation = validResults.sort((a, b) => (b.textLength || 0) - (a.textLength || 0))[0];

    btn.textContent = "Đang tóm tắt (Claude)...";

    const lang = document.getElementById("langSelect").value;
    const replyLang = document.getElementById("replyLangSelect").value;

    const response = await chrome.runtime.sendMessage({
      type: "SUMMARIZE_CONVERSATION",
      payload: { conversation, lang, replyLang },
    });

    if (response.error) {
      alert("Lỗi: " + response.error);
      return;
    }

    renderSummary(response.data, tab.url, conversation);
  } catch (err) {
    alert("Có lỗi xảy ra: " + String(err));
  } finally {
    btn.disabled = false;
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
    debugEl.textContent = `📍 Đã đọc: "${debugInfo.title || sourceUrl}"${frameNote} · ${debugInfo.messageCount} dòng${scrollNote} · ${debugInfo.method}`;
    debugEl.title = debugInfo.url;
  }

  const p = document.getElementById("priorityLabel");
  p.innerHTML = `Priority: <span class="priority-${data.priority}">${data.priority}</span>`;

  const tagsEl = document.getElementById("tagsContainer");
  tagsEl.innerHTML = "";
  (data.tags || []).forEach((t) => {
    const span = document.createElement("span");
    span.className = "chip";
    span.textContent = t;
    tagsEl.appendChild(span);
  });

  const actionsEl = document.getElementById("suggestedActions");
  actionsEl.innerHTML = "";

  const actions = [
    { label: "📎 Thêm conversation này vào Issue Tracking", action: () => addIssue({ sourceLink: sourceUrl, title: data.summary.slice(0, 80) }) },
    { label: `✉️ Gợi ý trả lời khách (${data.replyLang || "vi"})`, action: (evt) => draftReply(data, evt.currentTarget) },
  ];

  actions.forEach((a) => {
    const b = document.createElement("button");
    b.innerHTML = `${a.label}<span>›</span>`;
    b.addEventListener("click", a.action);
    actionsEl.appendChild(b);
  });

  // Ẩn khung gợi ý trả lời cũ (nếu có từ lần tóm tắt trước) khi tóm tắt mới
  document.getElementById("replyDraftSection").style.display = "none";
}

// Giữ lại data gốc của lần tóm tắt gần nhất để nút "Tạo lại câu trả lời" có
// thể gửi lại đúng context, kèm agentHint bổ sung, mà không cần tóm tắt lại.
let lastSummaryData = null;

async function draftReply(data, btn) {
  lastSummaryData = data;
  const originalHtml = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = "Đang soạn gợi ý..."; }

  try {
    const response = await chrome.runtime.sendMessage({ type: "DRAFT_REPLY", payload: data });
    if (response.error) {
      alert(response.error);
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
    if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
  }
}

document.getElementById("copyReplyBtn").addEventListener("click", () => {
  const textarea = document.getElementById("replyDraftText");
  navigator.clipboard.writeText(textarea.value);
  const btn = document.getElementById("copyReplyBtn");
  const original = btn.textContent;
  btn.textContent = "✓ Đã copy!";
  setTimeout(() => { btn.textContent = original; }, 1500);
});

document.getElementById("regenerateReplyBtn").addEventListener("click", async (e) => {
  if (!lastSummaryData) return;
  const btn = e.currentTarget;
  const hintValue = document.getElementById("replyHintInput").value.trim();

  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Đang tạo lại...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "DRAFT_REPLY",
      payload: { ...lastSummaryData, agentHint: hintValue },
    });
    if (response.error) {
      alert(response.error);
      return;
    }
    // Không xoá #replyHintInput — agent có thể bấm lại nhiều lần với ý bổ sung khác.
    document.getElementById("replyDraftText").value = response.data.reply;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

// ---------- TAB 2: Issue Tracking ----------

document.getElementById("addCurrentBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await addIssue({ sourceLink: tab.url, title: "(chưa có tiêu đề — sửa thủ công)" });
  renderIssues();
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
    alert("Vui lòng nhập ít nhất 1 link (Crisp hoặc Jira).");
    return;
  }

  // Tự nhận diện nếu 2 ô bị nhập NGƯỢC (VD: dán link Jira vào ô Crisp và
  // ngược lại — rất dễ xảy ra vì 2 ô trống trông giống nhau) và tự hoán đổi
  // lại, thay vì bắt lỗi "link không hợp lệ" một cách khó hiểu.
  const looksLikeJira = (v) => /atlassian\.net\/browse\//i.test(v);
  const looksLikeCrisp = (v) => /crisp\.chat/i.test(v);

  if (looksLikeJira(sourceLink) && looksLikeCrisp(jiraLink)) {
    [sourceLink, jiraLink] = [jiraLink, sourceLink];
    alert('Đã phát hiện 2 link bị nhập ngược ô ("Link Crisp" đang chứa link Jira và ngược lại) — tôi tự hoán đổi lại cho đúng trước khi lưu.');
  }

  const btn = document.getElementById("manualSaveBtn");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Đang lấy tiêu đề...";

  try {
    const { title, error } = await resolveIssueTitle({ sourceLink, jiraLink });
    if (error) {
      alert("Không tự lấy được tiêu đề: " + error + "\n\nIssue vẫn được lưu — bạn có thể bấm nút 🔄 trên issue để thử đồng bộ lại sau, hoặc kiểm tra cấu hình Jira ở trang Cài đặt.");
    }
    await addIssue({ title, sourceLink, jiraLink });
    document.getElementById("manualCancelBtn").click(); // reset form + ẩn
    renderIssues();
  } finally {
    btn.disabled = false;
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
      const matchingTabs = await chrome.tabs.query({ url: sourceLink });
      if (matchingTabs.length > 0 && matchingTabs[0].title) return { title: matchingTabs[0].title, error: null };
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
    title: partial.title || "(chưa có tiêu đề)",
    sourceLink: partial.sourceLink || "",
    jiraLink: partial.jiraLink || "",
    slackLink: partial.slackLink || "",
    status: partial.status || "todo", // todo | inprogress | done
    reminderSent: false,
    reportedToCustomer: false,
    priority: partial.priority || false,
    createdAt: Date.now(),
  });
  await saveIssues(issues);
}

async function renderIssues() {
  const issues = await getIssues();
  const list = document.getElementById("issuesList");
  list.innerHTML = "";

  if (issues.length === 0) {
    list.innerHTML = `<div class="empty">Chưa có issue nào được theo dõi.</div>`;
    return;
  }

  // Đồng bộ status mới nhất từ Jira — LƯU LẠI LỖI nếu có, không âm thầm bỏ
  // qua như bản trước (đây là lý do status "Passed" trên Jira nhưng UI vẫn
  // hiện "To Do" mà không ai biết vì sao — API call đang lỗi mà không hiển thị).
  for (const issue of issues) {
    if (issue.jiraLink && issue.status !== "done") {
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
        issue.jiraSyncError = "Không lấy được status — kiểm tra lại link Jira có đúng dạng .../browse/PROJ-123 không.";
      }
    }
  }
  await saveIssues(issues);

  // Issue ưu tiên (priority = true) luôn nổi lên đầu; sort ổn định nên thứ tự
  // tương đối giữa các issue cùng nhóm ưu tiên không đổi.
  issues.sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));

  issues.forEach((issue) => {
    const card = document.createElement("div");
    card.className = "issue-card" + (issue.priority ? " issue-card-priority" : "");

    const statusClass = { todo: "status-todo", inprogress: "status-inprogress", done: "status-done" }[issue.status] || "status-todo";
    // Ưu tiên hiển thị TÊN THẬT của status trên Jira (VD: "Passed", "QA Verified")
    // thay vì chỉ 3 nhãn cố định, để agent thấy đúng trạng thái thực tế.
    const statusLabel = issue.statusName || { todo: "To Do", inprogress: "In Progress", done: "Done" }[issue.status] || issue.status;

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:start;">
        <strong>${issue.title}</strong>
        <span style="display:flex; align-items:center; gap:4px;">
          <span class="status-badge ${statusClass}">${statusLabel}</span>
          <label style="display:flex; align-items:center; gap:2px; font-size:11px; cursor:pointer;" title="Đánh dấu ưu tiên">
            <input type="checkbox" class="priority-checkbox" data-id="${issue.id}" ${issue.priority ? "checked" : ""} /> ⭐ Ưu tiên
          </label>
          ${issue.jiraLink ? `<button class="secondary resync-issue" data-id="${issue.id}" title="Đồng bộ lại tiêu đề/status từ Jira" style="padding:2px 6px; font-size:11px;">🔄</button>` : ""}
        </span>
      </div>
      <div class="meta">
        ${issue.sourceLink ? `<a href="${issue.sourceLink}" target="_blank">Nguồn ↗</a>` : ""}
        ${issue.jiraLink ? ` · <a href="${issue.jiraLink}" target="_blank">Jira ↗</a>` : ` · <button class="secondary link-jira" data-id="${issue.id}">+ Link Jira</button>`}
        ${issue.slackLink ? ` · <a href="${issue.slackLink}" target="_blank">Slack ↗</a>` : ""}
        · <button class="secondary edit-title" data-id="${issue.id}" style="padding:1px 6px; font-size:11px;">✏️ Sửa tiêu đề</button>
      </div>
      ${issue.jiraSyncError ? `
        <div style="font-size:11px; color:var(--danger); margin-top:4px; word-break:break-word;">
          ⚠️ Lỗi đồng bộ Jira: ${issue.jiraSyncError}
        </div>` : ""}
      ${issue.status === "done" && !issue.reportedToCustomer ? `
        <div class="reminder-banner">
          <span>✅ Jira đã ${issue.statusName || "Done"} — đã báo khách chưa?</span>
        </div>` : ""}
      <div style="margin-top:6px; display:flex; justify-content:space-between; align-items:center;">
        <label style="display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;">
          <input type="checkbox" class="mark-reported-checkbox" data-id="${issue.id}" ${issue.reportedToCustomer ? "checked" : ""} />
          Đã báo khách
        </label>
        <button class="secondary remove-issue" data-id="${issue.id}">Xoá</button>
      </div>
    `;
    list.appendChild(card);
  });

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
      const statusRes = await chrome.runtime.sendMessage({ type: "GET_JIRA_STATUS", payload: { jiraLink: target.jiraLink } });
      if (statusRes?.data?.status) {
        target.status = statusRes.data.status;
        target.statusName = statusRes.data.statusName || null;
        target.jiraSyncError = null;
      } else if (statusRes?.error) {
        target.jiraSyncError = statusRes.error;
      }

      // Nếu tiêu đề vẫn đang là placeholder, thử lấy lại luôn
      if (target.title === "(chưa có tiêu đề — sửa thủ công)") {
        const { title, error } = await resolveIssueTitle({ sourceLink: target.sourceLink, jiraLink: target.jiraLink });
        if (title && title !== "(chưa có tiêu đề — sửa thủ công)") target.title = title;
        if (error) target.jiraSyncError = error;
      }

      await saveIssues(issues);
      renderIssues();
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
      renderIssues();
    })
  );

  list.querySelectorAll(".remove-issue").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const issues = (await getIssues()).filter((i) => i.id !== e.target.dataset.id);
      await saveIssues(issues);
      renderIssues();
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
      renderIssues();
    })
  );

  // Checkbox ưu tiên — tick/bỏ tick xong render lại ngay để card tự nhảy lên
  // đầu/xuống dưới theo đúng thứ tự ưu tiên mới.
  list.querySelectorAll(".priority-checkbox").forEach((cb) =>
    cb.addEventListener("change", async (e) => {
      const issues = await getIssues();
      const target = issues.find((i) => i.id === e.target.dataset.id);
      if (target) target.priority = e.target.checked;
      await saveIssues(issues);
      renderIssues();
    })
  );

  list.querySelectorAll(".link-jira").forEach((b) =>
    b.addEventListener("click", async (e) => {
      const url = prompt("Dán link Jira issue:");
      if (!url) return;
      const issues = await getIssues();
      const target = issues.find((i) => i.id === e.target.dataset.id);
      if (target) target.jiraLink = url;
      await saveIssues(issues);
      renderIssues();
    })
  );
}

renderIssues();
