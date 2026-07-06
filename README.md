# Tool Support Claude

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-blue.svg)](https://marketplace.visualstudio.com)

**Tool Support Claude** là một extension Visual Studio Code nhẹ dưới dạng một máy chủ Proxy cục bộ (local proxy server) giúp kết nối và làm cầu nối cho **Claude Code CLI** với các API AI nội bộ (ví dụ: các API tương thích với OpenAI hoặc Anthropic định tuyến qua các cổng AI nội bộ như Gameloft ASK AI).

Extension này tự động định cấu hình cài đặt cho Claude Code của bạn tại `~/.claude/settings.json`, giúp bạn có thể tận dụng toàn bộ sức mạnh của Claude Code CLI mà không cần kết nối trực tiếp đến máy chủ Anthropic, tăng tính bảo mật và tiết kiệm chi phí cho doanh nghiệp.

---

## 🚀 Tính năng chính

- **Máy chủ Proxy Cục bộ:** Chạy một máy chủ HTTP siêu nhẹ trên máy tính của bạn (mặc định cổng `20128`) để chuyển tiếp yêu cầu từ Claude Code CLI sang API AI đích.
- **Tự động cấu hình Claude Code:** Tự động phát hiện, sao lưu và cấu hình tệp `~/.claude/settings.json` khi máy chủ proxy được khởi động. Hoàn trả trạng thái khi tắt máy chủ.
- **Model Mapping:** Ánh xạ các model mà Claude Code yêu cầu (ví dụ: `claude-3-5-sonnet-latest`) sang các model được hỗ trợ bởi API nội bộ của bạn.
- **Bảng điều khiển Webview trực quan:** Một giao diện Sidebar thân thiện giúp bạn bật/tắt máy chủ proxy, kiểm tra trạng thái kết nối, cấu hình tham số nhanh chóng.
- **Thanh trạng thái tiện lợi:** Theo dõi nhanh tình trạng hoạt động của Proxy Server ngay trên thanh trạng thái (Status Bar) của VS Code.

---

## 📋 Yêu cầu hệ thống

- **VS Code:** Phiên bản `1.80.0` trở lên.
- **Node.js:** Phiên bản `18.x` trở lên (để chạy CLI và máy chủ proxy).
- **Claude Code CLI:** Đã được cài đặt thông qua npm (`npm install -g @anthropic-ai/claude-code`).

---

## 🛠️ Hướng dẫn sử dụng

### Bước 1: Khởi động Proxy Server
1. Mở VS Code.
2. Click vào nút **Tool Support Claude: Stopped** trên thanh trạng thái (Status Bar) ở góc dưới cùng bên phải để chuyển sang trạng thái **Running**.
3. Hoặc mở Sidebar **Tool Support Claude** (biểu tượng robot/công cụ trên thanh Activity Bar bên trái) và nhấn nút **Start Proxy Server**.

### Bước 2: Cấu hình API đích
Trong Sidebar của Extension hoặc trong Cài đặt của VS Code (`Ctrl+,` -> tìm kiếm `Tool Support Claude`), thiết lập các thông số sau:
- **Port:** Cổng chạy proxy cục bộ (mặc định là `20128`).
- **API Endpoint:** URL của API AI nội bộ của bạn (ví dụ: `https://ask.ai.gameloft.org/api`).
- **API Key:** Khóa API của bạn để xác thực với máy chủ AI đích.
- **Model Mapping:** Bảng ánh xạ định dạng JSON giúp chuyển đổi các model Claude Code yêu cầu sang model đích phù hợp.

### Bước 3: Chạy Claude Code CLI
Mở terminal trong dự án của bạn và chạy lệnh sau để bắt đầu làm việc với Claude Code:
```bash
claude
```
Claude Code CLI sẽ tự động kết nối qua máy chủ proxy cục bộ do extension cung cấp và gửi các yêu cầu tới API AI nội bộ của bạn.

---

## ⚙️ Các cấu hình (Settings)

Extension cung cấp các cài đặt cấu hình thông qua bảng cấu hình tiêu chuẩn của VS Code:

| Cấu hình | Kiểu dữ liệu | Mặc định | Mô tả |
| :--- | :--- | :--- | :--- |
| `toolSupportClaude.port` | `number` | `20128` | Cổng mạng mà máy chủ proxy cục bộ sẽ lắng nghe. |
| `toolSupportClaude.apiEndpoint` | `string` | `https://ask.ai.gameloft.org/api` | Địa chỉ Endpoint API AI đích để chuyển tiếp yêu cầu. |
| `toolSupportClaude.apiKey` | `string` | `api_key_here` | API Key dùng để xác thực các yêu cầu gửi tới API Endpoint. |
| `toolSupportClaude.modelMapping` | `object` | *Xem bên dưới* | Ánh xạ tên model từ Claude Code CLI sang API đích của bạn. |

**Cấu hình Model Mapping mặc định:**
```json
{
  "claude-3-5-sonnet-20241022": "model-sonnet-3-5",
  "claude-3-5-sonnet-latest": "model-sonnet-3-5",
  "claude-3-5-haiku-20241022": "model-haiku-3-5"
}
```

---

## ⌨️ Các lệnh hỗ trợ (Commands)

Extension đóng góp các lệnh sau vào Command Palette (`Ctrl+Shift+P`):

- `Tool Support Claude: Toggle Local Proxy Server` - Bật/tắt hoạt động của máy chủ Proxy cục bộ.
- `Tool Support Claude: Connect Claude Code CLI` - Áp dụng cấu hình và cập nhật cài đặt Claude Code ở máy khách.

---

## 📄 Giấy phép

Dự án này được phân phối dưới giấy phép **MIT**. Xem tệp [LICENSE](LICENSE) để biết thêm thông tin chi tiết.
