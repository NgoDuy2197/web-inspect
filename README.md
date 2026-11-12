# Network Tracer

Mở một trang web bằng trình duyệt điều khiển qua Playwright và xem mọi request, response và WebSocket trên giao diện giống tab Network của DevTools.

![icon](assets/icon.png)

## Tính năng

- Nhập URL, chọn `http://` hoặc `https://`, rồi mở trang trong một cửa sổ trình duyệt riêng.
- Danh sách request cập nhật trực tiếp, lọc theo loại giống DevTools: Fetch/XHR, Doc, CSS, JS, Font, Img, Media, Manifest, Socket, Wasm, Other.
- Ô lọc hỗ trợ:
  - text thường;
  - regex dạng `/regex/`;
  - loại trừ bằng `-text`;
  - các bộ lọc `status:404`, `method:POST`, `domain:api`, `type:`, `mime:`.
- Có thể chỉ hiện request lỗi.
- Chi tiết một request gồm các tab:
  - Headers: đầy đủ, kể cả cookie, xem được dạng gốc;
  - Payload: query string và body;
  - Response: JSON được tô màu, ảnh xem trước được;
  - Timing;
  - Messages: dành cho WebSocket.
- Nút Copy URL, Copy cURL, Copy JSON.
- Xuất các request đang hiển thị ra file JSON.
- Nút xóa toàn bộ request.

## Chạy

| Cách | Lệnh |
|---|---|
| Từ source (cần Node.js 18+) | `run.bat` hoặc `npm start` |
| Build file exe | `build.bat`, kết quả nằm ở `dist\NetworkTracer.exe` |

Khi chạy, tool tự mở giao diện tại `http://127.0.0.1:17890`. Đổi cổng bằng biến môi trường `PORT`, tắt tự mở trình duyệt bằng `NO_OPEN=1`.

## Trình duyệt dùng để mở trang

Tool thử lần lượt:

1. Chromium của Playwright, nếu đã cài bằng `npx playwright install chromium`;
2. Microsoft Edge;
3. Google Chrome.

Vì vậy file exe vẫn chạy được trên máy chưa cài Playwright, miễn là máy có Edge hoặc Chrome.

## Lưu ý

Dữ liệu ghi lại có chứa cookie và token. Không chia sẻ file JSON đã xuất.
