# Support Assistant Extension — MVP scaffold

## Cài vào Chrome/Edge để chạy thử
1. Mở `chrome://extensions` (hoặc `edge://extensions`)
2. Bật "Developer mode"
3. Chọn "Load unpacked" → trỏ vào thư mục `support-assistant-extension`
4. Ghim extension lên toolbar, click icon → mở Side Panel

## Trước khi dùng
1. Vào **Cài đặt** (nút góc trên side panel) → nhập:
   - Claude API key
   - Jira base URL / email / API token / project key (nếu muốn test tạo issue)
2. Mở bất kỳ tab nào có nội dung hội thoại support (Crisp, Intercom, Zendesk, hoặc trang bất kỳ) → mở side panel → bấm **Tóm tắt cuộc trò chuyện**

## Cách hoạt động (quan trọng)
- **Không có gì tự động chạy khi mở trang hay mở side panel.** `content.js` KHÔNG được khai báo tự inject (không có `content_scripts` trong `manifest.json`).
- Chỉ khi agent bấm nút **"Tóm tắt cuộc trò chuyện"**, `sidepanel.js` mới:
  1. Inject `content.js` vào đúng tab đang active tại thời điểm bấm (`chrome.scripting.executeScript`).
  2. Gọi hàm trích xuất text từ trang đó.
  3. Gửi text sang `background.js` → gọi Claude API để tóm tắt/chấm priority/gắn tag.
- Extension xin `host_permissions` cho `http://*/*` và `https://*/*` để `chrome.scripting.executeScript` chạy được trên **mọi tab đang mở tại thời điểm bấm nút**, kể cả khi side panel đã mở từ trước và bạn chuyển sang tab khác.
  - *Lý do không dùng riêng `activeTab`*: quyền `activeTab` chỉ cấp cho đúng tab đang active **tại thời điểm bạn mở side panel** (click icon extension) — nếu sau đó bạn chuyển tab rồi mới bấm Tóm tắt, tab mới sẽ KHÔNG có quyền và bị lỗi `Cannot access contents of the page`. Vì side panel của bạn cần hoạt động trên tab bất kỳ đang xem, phải xin host permission rộng thay vì phụ thuộc gesture của `activeTab`.

### Trích xuất nội dung (content.js) — tránh đọc lẫn nhiều hội thoại
Bản trước bị lỗi đọc lẫn nội dung từ sidebar danh sách hội thoại khác (do fallback đọc toàn bộ `document.body`). Bản này trích xuất theo thứ tự ưu tiên:
1. **Theo vị trí hình học (geometry)** — chỉ lấy text nằm trong dải cột giữa màn hình (mặc định 22%–68% chiều rộng viewport), tự động loại bỏ sidebar trái (danh sách hội thoại) và panel phải (thông tin khách). Cách này không phụ thuộc class CSS nên hoạt động được trên nhiều tool (Crisp/Intercom/Zendesk...) có layout 3 cột tương tự.
2. Nếu (1) không đọc đủ text → thử theo selector đặc thù từng nền tảng (best-effort).
3. Nếu vẫn không có gì → fallback đọc toàn trang.

Chỉnh 2 hằng số `MIDDLE_COLUMN_LEFT_RATIO` / `MIDDLE_COLUMN_RIGHT_RATIO` ở đầu `content.js` nếu layout thực tế khác tỉ lệ mặc định.

### Giới hạn lịch sử theo "resolved"
Nếu 1 thread có nhiều chu kỳ resolved/reopen dồn vào cùng 1 trang, `content.js` chỉ giữ lại tối đa `MAX_RESOLVED_CYCLES` (mặc định = **2**) chu kỳ resolved gần nhất + đoạn đang mở, tránh tóm tắt bị loãng bởi lịch sử quá cũ. Đây là heuristic dựa trên việc tìm dòng ngắn chứa từ "resolved" — nếu Crisp hiển thị mốc resolved bằng text khác, cần chỉnh lại regex trong hàm `trimResolvedHistory()`.

### Tự động cuộn để load hết lịch sử (virtualized list) — dừng sớm đúng theo giới hạn resolved
Nhiều tool support (khả năng cao là Crisp) chỉ render tin nhắn đang HIỂN THỊ trong khung nhìn vào DOM — tin nhắn cũ hơn (đã cuộn qua) không tồn tại trong DOM cho tới khi cuộn tới đó ("virtualized list"). Bản này tự động: tìm khung có thể cuộn chứa danh sách tin nhắn trong đúng cột chat → cuộn lên đầu nhiều lần (chờ tool load thêm mỗi lần) → **dừng ngay khi đã thấy đủ `MAX_RESOLVED_CYCLES` (mặc định = 2) mốc "resolved" trong DOM**, không cuộn/tải xa hơn nữa — vừa đúng yêu cầu giới hạn, vừa nhanh hơn nhiều so với việc tải hết lịch sử rồi mới cắt bớt. Nếu hội thoại chưa có đủ 2 mốc resolved thì dừng khi chạm đầu hội thoại thật (không còn nội dung mới để load) hoặc chạm giới hạn số lần cuộn tối đa. Sau đó cuộn lại về vị trí ban đầu để không làm xáo trộn màn hình agent đang xem. Vì bước này cần chờ tải, quá trình đọc có thể mất vài giây — nút sẽ hiển thị "Đang tải lịch sử & đọc nội dung tab...". Dòng debug info phía trên kết quả sẽ ghi rõ lý do dừng cuộn (VD: "đủ 2 mốc resolved" / "hết lịch sử" / "chạm giới hạn cuộn").
### Đọc được cả nội dung nằm trong iframe
Nếu khung chat của tool support (Crisp/Intercom/Zendesk...) nằm trong 1 `<iframe>` riêng thay vì thẳng trong trang chính, bản trước sẽ bỏ lỡ toàn bộ nội dung đó (chỉ đọc được vài ký tự/emoji lẻ nằm ngoài iframe). Bản này inject `content.js` vào **tất cả frame của tab** (`allFrames: true`), rồi tự chọn ra frame có nội dung dài/đầy đủ nhất để tóm tắt.

### Xác định cột chat theo ô nhập tin nhắn (thay vì tỉ lệ % cố định)
Ở frame chính (top frame), thay vì đoán cột chat nằm ở 22%–68% chiều rộng màn hình (dễ sai khi sidebar co giãn), `content.js` giờ tìm ô nhập tin nhắn (input/textarea có placeholder chứa "message"/"chat"/"tin nhắn") để lấy toạ độ thật của cột chat — chính xác hơn nhiều và tự thích ứng theo kích thước cửa sổ.

### Hiển thị nguồn đã đọc để xác minh khi test
Sau khi bấm Tóm tắt, side panel hiển thị 1 dòng nhỏ phía trên kết quả: tiêu đề trang, có đọc từ iframe hay không, số dòng đọc được, và phương pháp trích xuất đã dùng — giúp bạn xác nhận đúng conversation đã được đọc (VD: đúng "Sabine Schmid" chứ không phải hội thoại khác) trước khi tin tưởng bản tóm tắt.

### Đa ngôn ngữ
Nội dung hội thoại gốc có thể ở bất kỳ ngôn ngữ nào (Đức, Anh, Việt...) — Claude tự đọc hiểu đúng ngôn ngữ gốc và tóm tắt theo ngôn ngữ bạn chọn ở dropdown "Tóm tắt". Vấn đề trước đó là do content bị đọc sai/thiếu (do lỗi iframe ở trên) chứ không phải do rào cản ngôn ngữ.

### Gợi ý trả lời khách — review/edit trước khi copy
Trước đây bấm "Gợi ý trả lời khách" sẽ tự copy thẳng vào clipboard. Giờ nội dung gợi ý hiện ra trong 1 khung textarea ngay trong panel để agent **xem lại và chỉnh sửa nếu cần**, sau đó mới bấm nút "📋 Copy nội dung" để copy (copy đúng bản đã chỉnh sửa, không phải bản gốc AI sinh ra).

### Đã bỏ tính năng "Tạo issue Jira từ tóm tắt"
Theo yêu cầu, nút này đã được gỡ khỏi tab Tóm tắt. Muốn gắn issue Jira cho 1 conversation, dùng tab **Issue Tracking** → "+ Thêm thủ công" hoặc "+ Link Jira" trên issue đã có. (Handler `createJiraIssue` trong `background.js` vẫn còn giữ lại — có thể tái sử dụng sau này nếu cần bật lại tính năng tạo issue tự động.)

### Thêm issue thủ công — tự động lấy tiêu đề, không cần gõ tay
Form "+ Thêm thủ công" giờ chỉ cần Link Crisp và/hoặc Link Jira, không còn ô Tiêu đề. Khi lưu, `sidepanel.js` tự xác định tiêu đề theo thứ tự ưu tiên:
1. Nếu có Link Jira → gọi Jira REST API (`GET_JIRA_TITLE` trong `background.js`, dùng chung nền tảng Jira integration đã có sẵn, không thêm backend mới) lấy `fields.summary` của issue làm tiêu đề.
2. Nếu không có Link Jira nhưng có Link Crisp → tìm tab đang mở khớp đúng URL đó (`chrome.tabs.query({url})`) và lấy `tab.title` làm tiêu đề.
3. Nếu cả 2 đều không lấy được (VD: chưa cấu hình Jira, hoặc tab Crisp không còn mở) → fallback `"(chưa có tiêu đề — sửa thủ công)"`, agent vẫn có thể sửa lại tiêu đề sau trong danh sách issue.

### Hiển thị lỗi đồng bộ Jira thay vì âm thầm bỏ qua
Bản trước khi gọi Jira API thất bại (sai cấu hình, sai định dạng link, lỗi auth...) sẽ âm thầm giữ nguyên giá trị cũ mà không báo gì — khiến agent không biết vì sao title/status không tự cập nhật dù đã có link Jira. Bản này:
- Lưu lỗi vào `issue.jiraSyncError` và hiển thị ngay trên card issue (dòng đỏ nhỏ) mỗi khi đồng bộ status thất bại.
- Thêm nút **🔄** cạnh badge status trên mỗi issue có link Jira — agent bấm để chủ động đồng bộ lại status, và nếu tiêu đề vẫn đang là placeholder thì thử lấy lại tiêu đề luôn.
- Thêm nút **✏️ Sửa tiêu đề** để agent tự đặt/sửa tiêu đề bất cứ lúc nào, không phụ thuộc việc tự động lấy có thành công hay không.

Nếu vẫn thấy dòng lỗi đỏ sau khi bấm 🔄, đọc đúng nội dung lỗi đó — thường là do chưa điền đủ Jira Base URL / Email / API Token ở trang **Cài đặt**, hoặc link Jira sai định dạng (phải đúng dạng `.../browse/PROJ-123`).

### Lưu bền vững Issue Tracking (không mất khi tắt trình duyệt)
Bản trước dùng `chrome.storage.sync` để lưu danh sách issue — loại storage này có giới hạn rất nhỏ (~8KB cho mỗi item, tất cả issue lại đang lưu chung 1 key), nên khi danh sách issue lớn dần rất dễ **âm thầm lưu thất bại** mà không báo lỗi gì, gây mất dữ liệu. Bản này chuyển sang `chrome.storage.local` (quota mặc định 5MB, không giới hạn theo từng item, đã bật thêm quyền `unlimitedStorage` để an toàn hơn nữa) — dữ liệu vẫn **bền vững qua các lần tắt/mở trình duyệt hoặc restart máy**, chỉ khác là không đồng bộ giữa nhiều máy khác nhau (Google account) như sync — điều mà vốn dĩ cũng không đáng tin cậy do giới hạn dung lượng ở trên. Có migration tự động: nếu bạn đã có issue lưu từ bản cũ (storage.sync), lần đầu mở bản mới sẽ tự chuyển dữ liệu đó sang storage.local, không bị mất.
### Tự phát hiện & sửa khi 2 link bị nhập ngược ô
Vì 2 ô "Link Crisp" và "Link Jira" ở form thêm thủ công trông giống nhau, rất dễ dán nhầm ngược (VD: dán link `atlassian.net/browse/...` vào ô Crisp, dán link `crisp.chat` vào ô Jira) — dẫn tới lỗi khó hiểu "Link Jira không hợp lệ" dù link đó thực ra hợp lệ, chỉ là nằm sai ô. Bản này tự nhận diện theo domain (`atlassian.net/browse/` = Jira, `crisp.chat` = Crisp) và tự hoán đổi lại trước khi lưu, kèm thông báo cho agent biết đã tự sửa. Nút 🔄 trên issue cũng tự kiểm tra và sửa lại nếu issue đã lỡ được lưu bị ngược từ trước (không cần xoá tạo lại).

### Sửa lỗi status Jira không cập nhật đúng (VD: "Passed" vẫn hiện "To Do")
Nguyên nhân: bản trước đoán trạng thái Done bằng cách so khớp TÊN status (chỉ nhận "done"/"closed"/"resolved"), nên các workflow tuỳ biến như "Passed", "QA Verified", "Released"... không được nhận diện. Bản này chuyển sang dùng `statusCategory.key` do Jira trả về (`new` / `indeterminate` / `done`) — đây là phân loại chuẩn, ổn định của Jira bất kể team đặt tên status gì, nên sẽ luôn xác định đúng issue đã Done hay chưa. Badge trạng thái cũng hiển thị đúng TÊN THẬT của status trên Jira (VD: "Passed") thay vì chỉ 3 nhãn cố định.

### Checkbox "Đã báo khách" — agent chủ động tick bất kỳ lúc nào
Trước đây nút "Đã báo" chỉ xuất hiện trong banner nhắc khi Jira đã Done. Giờ mỗi issue có sẵn 1 checkbox "Đã báo khách" hiển thị thường trực — agent tick/bỏ tick chủ động bất cứ lúc nào. Banner nhắc "đã báo khách chưa?" **chỉ xuất hiện khi status = Done** — các status khác (To Do/In Progress) chỉ cập nhật badge, không hỏi nhắc gì thêm (đúng hành vi mong muốn).

### Sửa lỗi đếm nhầm "resolved" từ badge "Unresolved"
Regex `/resolved/i` trước đó khớp luôn cả chữ **"Unresolved"** (badge trạng thái hiển thị cố định trên đầu mọi conversation, không cần cuộn tới) — khiến hệ thống tưởng đã đủ 2 mốc resolved ngay từ vòng lặp cuộn đầu tiên, dừng cuộn quá sớm trước khi kịp load lịch sử thật, dẫn tới tóm tắt sai/thiếu nội dung. Đã sửa cả 2 chỗ dùng regex (đếm nhanh khi cuộn + trim lịch sử cuối cùng) để loại trừ "Unresolved".

### Thêm chiến lược dò cột chat qua toolbar nhãn (khi placeholder không phải thuộc tính DOM thật)
Nếu ô soạn tin là rich-text editor (contenteditable) hiển thị placeholder bằng CSS thay vì thuộc tính `placeholder` thật, chiến lược dò theo input sẽ không tìm thấy (rơi về `column-by-ratio`, kém chính xác hơn). Bản này thêm chiến lược dự phòng: tìm toolbar phía trên ô soạn tin dựa theo các nhãn TEXT thật trong DOM ("Reply", "Edit", "Note", "Shortcuts", "Knowledge Base" — đúng như toolbar của Crisp), dùng vị trí toolbar đó làm mốc cột chat khi không tìm được qua placeholder.

## ⚠️ Việc CẦN làm trước khi dùng thật với team (production)
- Selector trong `content.js` là best-effort — nếu Crisp đổi UI, nên thay bằng gọi thẳng Crisp API (`list_website_conversation_messages`) qua OAuth thay vì scrape DOM, sẽ bền hơn.
- `background.js` gọi thẳng Claude API kèm header `anthropic-dangerous-direct-browser-access: true` — header này Anthropic yêu cầu chính vì gọi trực tiếp từ browser là **không an toàn cho production**: bất kỳ ai mở DevTools trên máy đang cài extension đều có thể xem được API key trong request. Chỉ nên chấp nhận rủi ro này khi test nội bộ nhỏ; khi triển khai thật cho cả team, bắt buộc chuyển sang gọi qua backend proxy (xem `PROPOSAL.md` mục 5) để giấu key.
- Đừng để agent tự nhập Claude/Jira API key cá nhân ở bản chính thức — dựng backend proxy dùng chung để bảo mật + đồng bộ issue-tracking giữa nhiều agent (hiện bản này dùng `chrome.storage.sync`, chỉ đồng bộ được giữa các máy đăng nhập CÙNG 1 tài khoản Chrome, KHÔNG chia sẻ được giữa các agent khác nhau).
- Slack integration (đọc/ghi status) chưa code trong bản này — cần Slack app + OAuth scope `channels:history`, thêm handler tương tự `getJiraStatus` trong `background.js`.

## Cấu trúc file
```
manifest.json      - khai báo permissions, side panel, content script
sidepanel.html/js   - UI chính (tab Tóm tắt + tab Issue Tracking)
content.js          - trích xuất tin nhắn từ DOM Crisp
background.js       - gọi Claude API + Jira API (service worker)
options.html/js      - trang cấu hình API key
PROPOSAL.md          - đề xuất sản phẩm & roadmap đầy đủ
```
