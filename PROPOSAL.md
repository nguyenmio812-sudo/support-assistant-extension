# Đề xuất: Support Assistant Extension (Chrome/Edge nội bộ)

**Vai trò:** Product Owner + Lead Dev
**Mục tiêu:** Giúp agent support xử lý hội thoại (Crisp) nhanh hơn — tóm tắt, gắn tag/priority tự động, và theo dõi issue Jira/Slack ngay trong 1 side panel, không cần chuyển tab qua lại.

---

## 1. Bài toán hiện tại
Agent đang mất thời gian vì:
- Đọc lại toàn bộ hội thoại dài để nắm vấn đề trước khi trả lời.
- Tự phân loại/ưu tiên issue theo cảm tính, không đồng nhất giữa các agent.
- Theo dõi issue đã báo Jira thủ công (dễ quên nhắc lại khi dev đã fix xong).
- Không có nơi tổng hợp: 1 conversation Crisp có thể liên quan 1-2 issue Jira, nhưng hiện tại thông tin nằm rời rạc ở Crisp, Jira, Slack.

## 2. Đề xuất kiến trúc

```
┌─────────────────────────────┐
│  Chrome/Edge Extension (MV3) │
│  ┌───────────┐  ┌──────────┐ │
│  │ Side Panel │  │ Content  │ │
│  │  (UI)      │◄─┤ Script   │ │   đọc DOM cuộc trò chuyện
│  └─────┬─────┘  └──────────┘ │   trên tab Crisp hiện tại
│        │                     │
│  ┌─────▼─────┐               │
│  │ Background │               │
│  │ Service    │───────────────┼──► Claude API (tóm tắt/tag/priority/dịch)
│  │ Worker     │───────────────┼──► Jira REST API (tạo/link/lấy status issue)
│  └───────────┘───────────────┼──► Slack API (đọc trạng thái, gửi reminder)
└─────────────────────────────┘
                │
        chrome.storage.sync  (cấu hình cá nhân, API key)
        + Backend nhẹ (khuyến nghị) để đồng bộ issue-tracking
          giữa nhiều agent (xem mục 5)
```

**Điểm quan trọng:** Nên có Side Panel (Chrome Side Panel API) thay vì chỉ popup — vì agent cần vừa xem hội thoại Crisp vừa thao tác, giống ảnh mẫu bạn gửi.

## 3. Tính năng chi tiết

### 3.1 Đọc & tóm tắt hội thoại (nút "Tóm tắt")
- Content script trích xuất toàn bộ tin nhắn của conversation đang mở trên Crisp (dùng Crisp API `list_website_conversation_messages` nếu có OAuth, ưu tiên hơn scrape DOM vì bền hơn khi Crisp đổi UI).
- Gửi qua background worker → gọi Claude API để tóm tắt theo prompt chuẩn hoá (vấn đề chính, đã thử gì, đang chờ gì).
- Hiển thị tóm tắt + 3 nút hành động gợi ý (giống ảnh: "Highlight excerpts", "Clarify key concepts", trong case của bạn có thể là "Tạo issue Jira", "Trả lời khách", "Đánh dấu ưu tiên").

### 3.2 Chọn ngôn ngữ chat
- Dropdown ngôn ngữ (VD: Việt/Anh/Thái…) áp cho: (a) ngôn ngữ tóm tắt hiển thị cho agent, (b) ngôn ngữ gợi ý câu trả lời để gửi khách — tách 2 setting riêng vì agent có thể đọc tiếng Anh nhưng cần trả lời khách bằng tiếng Việt hoặc ngược lại.

### 3.3 Priority tự động
- Claude chấm điểm dựa trên: từ khoá khẩn cấp, số lần khách nhắn lại, thời gian chờ, có nhắc "refund/broken/urgent" không.
- Hiển thị nhãn P1–P4, **cho phép agent override thủ công** (rất quan trọng — model gợi ý không được khoá cứng).

### 3.4 Tag phân loại tự động
- Danh sách tag cấu hình sẵn theo domain nghiệp vụ (Bug, Billing, Feature Request, Account, Shopify integration…).
- Claude chọn tag phù hợp nhất + agent có thể thêm/xoá tag thủ công (multi-select).
- Lưu tag vào Crisp conversation qua `update_website_conversation_meta` để đồng bộ ngược lại Crisp segment.

### 3.5 Tab "Issue Tracking" (phần phức tạp nhất — nên làm kỹ)
UI dạng list, mỗi row = 1 issue đang theo dõi, gồm:

| Trường | Nguồn | Ghi chú |
|---|---|---|
| Link Crisp | agent add/xoá thủ công (auto-fill từ tab đang mở) | 1-click "Add current conversation" |
| Link Jira | agent add/xoá thủ công, hoặc tạo issue mới ngay trong panel | gọi Jira REST API `POST /issue` |
| Status | pull tự động từ Jira (`To Do/In Progress/Done`) | poll định kỳ hoặc webhook Jira→backend |
| Slack thread | optional, để agent nhảy sang thảo luận nhanh | đọc status nếu message có emoji/label chuẩn hoá |
| Reminder | khi Jira chuyển `Done`, hệ thống nhắc agent **1 lần duy nhất** "đã báo khách chưa?" | agent tick "Đã báo khách" → tắt reminder, lưu timestamp |

- Vì đây là dữ liệu **dùng chung giữa nhiều agent** (issue có thể do agent A tạo, agent B follow), **nên có backend nhẹ** (Cloudflare Worker/Supabase/Firebase) thay vì chỉ `chrome.storage` local — nếu không, mỗi agent chỉ thấy issue của riêng mình.
- Webhook Jira → backend → cập nhật status realtime, extension chỉ đọc từ backend (tránh mỗi agent tự gọi Jira API riêng, dễ vượt rate limit và lộ token cá nhân).

## 4. Quyền & bảo mật
- `host_permissions` chỉ nên xin đúng domain: Crisp, Jira Cloud, Slack — không xin `<all_urls>`.
- API key Claude / Jira token **không hardcode trong extension**, lưu ở backend, extension chỉ gọi qua backend proxy có auth theo agent (SSO nội bộ).
- Vì extension đọc nội dung chat khách hàng → cần rà soát dữ liệu cá nhân (PII) trước khi gửi qua Claude API, tuân theo chính sách bảo mật dữ liệu khách hàng của công ty.

## 5. Đề xuất tech stack
- **Extension:** Manifest V3, Side Panel API, vanilla JS hoặc React nhẹ (nếu team quen React, dùng Vite + CRXJS để build nhanh).
- **Backend (khuyến nghị, không bắt buộc ở MVP):** Cloudflare Workers + KV/D1, hoặc Supabase — dùng để: lưu issue-tracking dùng chung, proxy gọi Claude/Jira/Slack an toàn, nhận webhook Jira.
- **AI:** Claude API (model Sonnet là đủ cho tóm tắt/tag/priority, không cần model nặng).

## 6. Roadmap đề xuất
| Phase | Nội dung | Thời gian ước tính |
|---|---|---|
| MVP (Phase 1) | Đọc tab Crisp hiện tại, tóm tắt, chọn ngôn ngữ, tag/priority gợi ý (không backend, lưu local) | 1–1.5 tuần |
| Phase 2 | Tab Issue Tracking: add/xoá link Jira/Crisp thủ công, hiển thị status Jira (poll API) | 1 tuần |
| Phase 3 | Backend dùng chung + webhook Jira realtime + reminder tick-off + đồng bộ Slack | 1.5–2 tuần |
| Phase 4 | Đồng bộ tag ngược lại Crisp, dashboard thống kê (số issue/priority theo agent) | tuỳ nhu cầu |

## 7. Rủi ro cần lưu ý
- Crisp có thể đổi DOM → nên ưu tiên dùng Crisp API (bạn đã có connector Crisp) thay vì scrape trực tiếp, để không vỡ mỗi lần Crisp update UI.
- Jira API rate limit nếu mỗi agent tự poll — nên qua backend cache chung.
- Reminder "1 lần duy nhất" cần lưu trạng thái bền (không chỉ trong session popup) — bắt buộc phải có storage backend hoặc `chrome.storage.sync` tối thiểu.

---

Tôi đã dựng kèm một **scaffold MVP** (Phase 1) ở phần code bên dưới — manifest, side panel UI, content script đọc Crisp, background worker gọi Claude API — để team có thể chạy thử và mở rộng dần theo roadmap trên.
