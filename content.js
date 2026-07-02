// content.js — CHỈ được inject vào trang khi agent bấm nút "Tóm tắt" trong
// side panel (xem sidepanel.js). Không tự động chạy khi mở trang, không đọc
// gì cho tới khi được gọi tường minh bởi executeScript.
//
// QUAN TRỌNG #1: nhiều tool support (khả năng cao là Crisp) render khung chat
// bên trong 1 <iframe> riêng. Vì vậy sidepanel.js inject file này vào TẤT CẢ
// frame của tab (allFrames: true), rồi tự chọn ra frame có nội dung tốt nhất.
//
// QUAN TRỌNG #2: khung chat thường dùng "virtualized list" — chỉ những tin
// nhắn đang HIỂN THỊ trong khung nhìn mới thực sự nằm trong DOM, tin nhắn cũ
// hơn (đã cuộn qua) sẽ KHÔNG có trong DOM cho tới khi cuộn tới đó. Vì vậy
// trước khi đọc, hàm này tự động CUỘN LÊN ĐẦU khung chat vài lần (chờ Crisp
// load thêm lịch sử mỗi lần cuộn) để gom được nhiều tin nhắn nhất có thể,
// rồi mới trích xuất. Đây chính là nguyên nhân bản trước chỉ đọc được vài
// dòng đang hiển thị trên màn hình thay vì toàn bộ hội thoại.
//
// CHIẾN LƯỢC TRÍCH XUẤT trong MỖI frame:
//   - TOP FRAME: dùng vị trí Ô NHẬP TIN NHẮN làm mốc xác định cột chat thật
//     (chính xác hơn đoán tỉ lệ % cố định, tự thích ứng theo độ rộng sidebar).
//   - TRONG IFRAME: đọc toàn bộ nội dung frame đó (không cần giới hạn cột).
//   - TRIM THEO "RESOLVED": giữ tối đa MAX_RESOLVED_CYCLES chu kỳ gần nhất.

window.__extractSupportConversation = async function () {
  const MAX_CHARS = 14000;
  const MAX_RESOLVED_CYCLES = 2;
  const FALLBACK_LEFT_RATIO = 0.22;
  const FALLBACK_RIGHT_RATIO = 0.68;
  const SCROLL_MAX_ITERATIONS = 15;
  const SCROLL_WAIT_MS = 350;

  try {
    const isTopFrame = window.top === window.self;

    // ---------- Tìm mốc cột chat dựa vào ô nhập tin nhắn ----------
    function findConversationColumnBoundsByInputPlaceholder() {
      const inputLike = Array.from(
        document.querySelectorAll("textarea, input[type='text'], [contenteditable='true']")
      );
      for (const el of inputLike) {
        const hint = (
          (el.getAttribute("placeholder") || "") +
          " " +
          (el.getAttribute("aria-label") || "") +
          " " +
          (el.getAttribute("data-placeholder") || "")
        ).toLowerCase();
        if (
          hint.includes("message") ||
          hint.includes("chat") ||
          hint.includes("tin nhắn") ||
          hint.includes("nhắn")
        ) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 100) return { left: rect.left, right: rect.right };
        }
      }
      return null;
    }

    // ---------- Fallback: tìm cột chat qua toolbar nhãn (Reply/Edit/Note...) ----------
    // Nhiều editor soạn tin (rich-text/contenteditable) hiển thị placeholder
    // bằng CSS (::before / data-attribute không chuẩn), không phải thuộc tính
    // `placeholder` thật trong DOM — nên chiến lược trên không tìm thấy được.
    // Toolbar phía trên ô soạn tin (VD: "Reply", "Edit", "Note", "Shortcuts",
    // "Knowledge Base" như trong Crisp) luôn là TEXT thật trong DOM, dùng nó
    // làm mốc thay thế đáng tin cậy.
    function findConversationColumnBoundsByToolbarLabels() {
      const KNOWN_LABELS = ["reply", "edit", "note", "shortcuts", "knowledge base"];
      const candidates = document.querySelectorAll("body *");

      for (const el of candidates) {
        if (el.children.length < 3 || el.children.length > 10) continue;
        const childTexts = Array.from(el.children)
          .map((c) => c.textContent.trim().toLowerCase())
          .filter(Boolean);
        const matchCount = KNOWN_LABELS.filter((label) =>
          childTexts.some((t) => t === label || t.includes(label))
        ).length;

        if (matchCount >= 3) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 150) return { left: rect.left, right: rect.right };
        }
      }
      return null;
    }

    function findConversationColumnBounds() {
      return findConversationColumnBoundsByInputPlaceholder() || findConversationColumnBoundsByToolbarLabels();
    }

    // ---------- Tìm khung có thể cuộn được chứa danh sách tin nhắn ----------
    function findScrollableMessageContainer(leftBound, rightBound) {
      const all = document.querySelectorAll("body *");
      let best = null;
      let bestArea = 0;

      for (const el of all) {
        const style = getComputedStyle(el);
        if (style.overflowY !== "auto" && style.overflowY !== "scroll") continue;
        if (el.scrollHeight <= el.clientHeight + 20) continue; // không thực sự có nội dung để cuộn

        const rect = el.getBoundingClientRect();
        if (rect.width < 150 || rect.height < 150) continue;
        const centerX = rect.left + rect.width / 2;
        if (centerX < leftBound || centerX > rightBound) continue;

        const area = rect.width * rect.height;
        if (area > bestArea) {
          bestArea = area;
          best = el;
        }
      }
      return best;
    }

    // ---------- Đếm nhanh số mốc "resolved" đang có trong DOM (trong dải cột) ----------
    // Dùng để dừng cuộn sớm ngay khi đã đủ MAX_RESOLVED_CYCLES mốc trước đó,
    // không cần cuộn/tải xa hơn nữa — vừa nhanh hơn vừa đúng yêu cầu giới hạn.
    function countResolvedMarkersInBounds(leftBound, rightBound) {
      let count = 0;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const t = node.textContent.trim();
          if (t.length === 0 || t.length > 80) return NodeFilter.FILTER_REJECT;
          // /resolved/i khớp cả "Unresolved" (badge trạng thái hiển thị cố
          // định, không cần cuộn) — phải loại trừ để tránh dừng cuộn quá sớm.
          if (/unresolved/i.test(t) || !/resolved/i.test(t)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent) continue;
        const rect = parent.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (leftBound != null) {
          const centerX = rect.left + rect.width / 2;
          if (centerX < leftBound || centerX > rightBound) continue;
        }
        count++;
      }
      return count;
    }

    // ---------- Tự động cuộn lên đầu để Crisp/tool load lịch sử ----------
    // Dừng sớm khi: (a) đã đủ MAX_RESOLVED_CYCLES mốc "resolved" trong DOM
    // (không cần đọc xa hơn theo yêu cầu giới hạn), hoặc (b) không còn nội
    // dung mới được load thêm (đã chạm đầu hội thoại thật).
    async function autoScrollToLoadHistory(container, leftBound, rightBound) {
      if (!container) return { scrolled: false, iterations: 0, stoppedReason: "no-container" };
      const originalScrollTop = container.scrollTop;
      let lastScrollHeight = -1;
      let iterations = 0;
      let stoppedReason = "max-iterations";

      for (let i = 0; i < SCROLL_MAX_ITERATIONS; i++) {
        container.scrollTop = 0;
        await new Promise((resolve) => setTimeout(resolve, SCROLL_WAIT_MS));
        iterations++;

        const resolvedCount = countResolvedMarkersInBounds(leftBound, rightBound);
        if (resolvedCount >= MAX_RESOLVED_CYCLES) {
          stoppedReason = "reached-max-resolved-cycles";
          break;
        }

        if (container.scrollHeight === lastScrollHeight) {
          stoppedReason = "no-more-history";
          break;
        }
        lastScrollHeight = container.scrollHeight;
      }

      // Cuộn lại về vị trí ban đầu (thường là cuối hội thoại) để không làm
      // xáo trộn màn hình đang xem của agent.
      try {
        container.scrollTop = originalScrollTop;
      } catch (e) {
        /* ignore */
      }

      return { scrolled: true, iterations, stoppedReason };
    }

    // ---------- Đọc theo cột dựa trên bounds đã có ----------
    function extractColumnLines(leftBound, rightBound) {
      const seenTexts = new Set();
      const candidates = [];

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const t = node.textContent.trim();
          if (t.length < 2) return NodeFilter.FILTER_REJECT;
          const parentTag = node.parentElement?.tagName;
          if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parentTag)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent) continue;
        const rect = parent.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const centerX = rect.left + rect.width / 2;
        if (centerX < leftBound || centerX > rightBound) continue;

        const text = node.textContent.trim();
        const key = text + "@" + Math.round(rect.top + window.scrollY);
        if (seenTexts.has(key)) continue;
        seenTexts.add(key);

        candidates.push({ text, top: rect.top });
      }

      candidates.sort((a, b) => a.top - b.top);
      return candidates.map((c) => c.text);
    }

    // ---------- Selector đặc thù theo nền tảng ----------
    function extractByPlatformSelectors() {
      const PLATFORM_SELECTORS = [
        { name: "crisp", selectors: ["[class*='message-text']", "[class*='conversation-message']"] },
        { name: "intercom", selectors: ["[class*='intercom-comment-body']", "[class*='intercom-interblocks']"] },
        { name: "zendesk", selectors: ["[data-garden-id*='chat.message']", "[class*='zd-message']"] },
        { name: "generic-chat", selectors: ["[class*='chat-message']", "[class*='message-bubble']"] },
      ];

      for (const platform of PLATFORM_SELECTORS) {
        for (const sel of platform.selectors) {
          const found = document.querySelectorAll(sel);
          if (found.length >= 2) {
            const lines = Array.from(found).map((n) => n.innerText?.trim()).filter(Boolean);
            if (lines.length >= 2) return { lines, platform: platform.name };
          }
        }
      }
      return null;
    }

    // ---------- Toàn bộ nội dung frame hiện tại ----------
    function extractFullFrameLines() {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("script, style, noscript").forEach((el) => el.remove());
      const text = clone.innerText.replace(/\n{3,}/g, "\n\n").trim();
      return text.split("\n").map((l) => l.trim()).filter(Boolean);
    }

    // ---------- Trim theo số chu kỳ "resolved" ----------
    function trimResolvedHistory(lines, maxCycles) {
      const boundaryIdx = [];
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.length > 0 && t.length <= 80 && !/unresolved/i.test(t) && /resolved/i.test(t)) boundaryIdx.push(i);
      });
      if (boundaryIdx.length <= maxCycles) return { lines, trimmed: false, cyclesFound: boundaryIdx.length };

      const keepFromBoundaryPos = boundaryIdx.length - maxCycles;
      const startLine = boundaryIdx[keepFromBoundaryPos - 1] ?? -1;
      return { lines: lines.slice(startLine + 1), trimmed: true, cyclesFound: boundaryIdx.length };
    }

    let lines = [];
    let method = "";
    let scrollInfo = { scrolled: false, iterations: 0 };

    if (isTopFrame) {
      const anchorBounds = findConversationColumnBounds();
      const vw = window.innerWidth;
      const leftBound = anchorBounds ? anchorBounds.left - 20 : vw * FALLBACK_LEFT_RATIO;
      const rightBound = anchorBounds ? anchorBounds.right + 20 : vw * FALLBACK_RIGHT_RATIO;

      // Trước khi đọc: tìm khung cuộn chứa tin nhắn trong đúng dải cột này và
      // tự động cuộn lên đầu để load hết lịch sử (nếu tool dùng virtualized list).
      const scrollContainer = findScrollableMessageContainer(leftBound, rightBound);
      scrollInfo = await autoScrollToLoadHistory(scrollContainer, leftBound, rightBound);

      const colLines = extractColumnLines(leftBound, rightBound);
      const colText = colLines.join(" ").trim();

      if (colText.length > 150) {
        lines = colLines;
        method = anchorBounds ? "top-frame:column-by-input-anchor" : "top-frame:column-by-ratio";
      } else {
        const platformResult = extractByPlatformSelectors();
        if (platformResult) {
          lines = platformResult.lines;
          method = "top-frame:selector:" + platformResult.platform;
        } else {
          lines = extractFullFrameLines();
          method = "top-frame:fallback-full-body";
        }
      }
    } else {
      // Trong iframe: cũng thử cuộn lên đầu khung cuộn lớn nhất trong frame
      // (không giới hạn theo cột vì iframe nhiều khả năng đã là khung chat riêng).
      const bodyRect = document.body.getBoundingClientRect();
      const iframeLeft = 0;
      const iframeRight = bodyRect.width || window.innerWidth;
      const scrollContainer = findScrollableMessageContainer(iframeLeft, iframeRight);
      scrollInfo = await autoScrollToLoadHistory(scrollContainer, iframeLeft, iframeRight);

      const platformResult = extractByPlatformSelectors();
      if (platformResult) {
        lines = platformResult.lines;
        method = "iframe:selector:" + platformResult.platform;
      } else {
        lines = extractFullFrameLines();
        method = "iframe:full-body";
      }
    }

    const { lines: trimmedLines, trimmed, cyclesFound } = trimResolvedHistory(lines, MAX_RESOLVED_CYCLES);
    let text = trimmedLines.join("\n");

    if (!text || text.length < 20) {
      return { error: "not-enough-content", isTopFrame, frameUrl: window.location.href };
    }

    if (text.length > MAX_CHARS) {
      text = "[...phần đầu đã bị cắt bớt do quá dài...]\n" + text.slice(-MAX_CHARS);
    }

    return {
      url: window.location.href,
      title: document.title,
      isTopFrame,
      method,
      messageCount: trimmedLines.length,
      textLength: text.length,
      scrollInfo,
      resolvedTrim: { applied: trimmed, cyclesFoundInPage: cyclesFound, maxCyclesKept: MAX_RESOLVED_CYCLES },
      text,
    };
  } catch (err) {
    return { error: "Lỗi khi đọc nội dung trang: " + String(err) };
  }
};
