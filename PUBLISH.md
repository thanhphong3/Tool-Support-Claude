# Hướng dẫn Xuất bản Extension lên VS Code Marketplace

Tài liệu này hướng dẫn bạn từng bước cách đóng gói và xuất bản extension **Tool Support Claude** lên chợ ứng dụng chính thức của Visual Studio Code (Marketplace).

---

## 📋 Mục lục
1. [Bước 1: Đăng ký Nhà xuất bản (Publisher)](#bước-1-đăng-ký-nhà-xuất-bản-publisher)
2. [Bước 2: Tạo Personal Access Token (PAT) trên Azure DevOps](#bước-2-tạo-personal-access-token-pat-trên-azure-devops)
3. [Bước 3: Chuẩn bị thông tin dự án](#bước-3-chuẩn-bị-thông-tin-dự-án)
4. [Bước 4: Đóng gói Extension (.vsix)](#bước-4-đóng-gói-extension-vsix)
5. [Bước 5: Tải Extension lên Marketplace](#bước-5-tải-extension-lên-marketplace)

---

## 👤 Bước 1: Đăng ký Nhà xuất bản (Publisher)

Nhà xuất bản (Publisher) là định danh để hiển thị ai là người sở hữu extension trên Marketplace.

1. Truy cập trang quản trị nhà xuất bản của Visual Studio Marketplace:  
   👉 [Visual Studio Marketplace Management Portal](https://marketplace.visualstudio.com/manage)
2. Đăng nhập bằng tài khoản Microsoft của bạn.
3. Nếu bạn chưa có hồ sơ nhà xuất bản, hệ thống sẽ yêu cầu bạn tạo mới.
4. Điền các thông tin:
   - **Name:** Tên hiển thị của nhà xuất bản (ví dụ: `Thanh Phong`).
   - **ID (Trường quan trọng):** ID duy nhất của nhà xuất bản (ví dụ: `thanhphong`). **Lưu ý:** ID này phải trùng khớp hoàn toàn với trường `"publisher"` trong tệp `package.json` của dự án của bạn.

---

## 🔑 Bước 2: Tạo Personal Access Token (PAT) trên Azure DevOps

Để công cụ dòng lệnh (`vsce`) có quyền tải extension của bạn lên tài khoản nhà xuất bản, bạn cần tạo một Token truy cập (PAT).

1. Truy cập trang dịch vụ Azure DevOps: [Azure DevOps](https://dev.azure.com).
2. Đăng nhập bằng chính tài khoản Microsoft bạn dùng để đăng ký Publisher ở Bước 1.
3. Ở góc trên cùng bên phải màn hình, nhấn vào biểu tượng **User Settings** (bên cạnh ảnh đại diện) và chọn **Personal Access Tokens**.
4. Nhấn **New Token**.
5. Cấu hình thông tin Token như sau:
   - **Name:** Đặt tên dễ nhớ (ví dụ: `vsce-publisher-token`).
   - **Organization:** Bạn **BẮT BUỘC** phải chọn **All accessible organizations** (nếu chọn một tổ chức cụ thể, `vsce` sẽ báo lỗi khi xác thực).
   - **Expiration:** Chọn thời gian hết hạn mong muốn (ví dụ: 90 ngày hoặc 1 năm).
   - **Scopes:** Chọn mục **Custom defined** (Cấu hình thủ công).
   - Cuộn xuống dưới cùng, nhấn vào liên kết **Show all scopes** để hiện toàn bộ danh sách quyền.
   - Tìm mục **Marketplace** và tích chọn quyền **Publish** hoặc **Manage**.
6. Nhấn **Create** ở cuối trang.
7. **Lưu ý quan trọng:** Sao chép mã Token hiển thị trên màn hình và lưu lại ở nơi an toàn. Token này chỉ hiển thị **một lần duy nhất** và không thể xem lại sau khi bạn đóng trang.

---

## 📝 Bước 3: Chuẩn bị thông tin dự án

Trước khi đóng gói, hãy kiểm tra lại tệp `package.json` ở thư mục gốc của dự án:

1. Đảm bảo trường `"publisher"` khớp chính xác với **Publisher ID** đã đăng ký ở Bước 1.
2. Đảm bảo trường `"version"` là phiên bản bạn muốn xuất bản (ví dụ: `0.1.0` cho lần đầu tiên, tăng lên `0.1.1` hoặc `0.2.0` cho các lần cập nhật tiếp theo).
3. Đảm bảo các thông tin như `repository` (URL Git), `license` (MIT), `icon` (đường dẫn tới file biểu tượng PNG) đã được cấu hình đầy đủ.
4. Đảm bảo tệp `README.md` đã có nội dung giới thiệu chi tiết (Marketplace sẽ từ chối các extension có tệp README trống hoặc quá ngắn).

---

## 📦 Bước 4: Đóng gói Extension (.vsix)

Bạn cần đóng gói mã nguồn của mình thành một tệp nén duy nhất có định dạng `.vsix` để tải lên Marketplace.

Cách đơn giản nhất trên Windows là sử dụng tệp lệnh `package.bat` có sẵn trong dự án:

1. Mở cửa sổ Terminal hoặc Command Prompt tại thư mục dự án `Tool-Support-Claude`.
2. Chạy lệnh:
   ```cmd
   .\package.bat
   ```
3. Script sẽ tự động chạy các tác vụ:
   - Kiểm tra môi trường Node.js.
   - Tự động tải các thư viện phụ thuộc (`npm install`) nếu chưa có.
   - Biên dịch và tối ưu hóa mã nguồn bằng `esbuild` (`npm run vscode:prepublish`).
   - Đóng gói extension thành tệp tin có tên là `tool-support-claude-<phiên-bản>.vsix` (ví dụ: `tool-support-claude-0.1.0.vsix`) ở thư mục gốc của dự án.

---

## 🚀 Bước 5: Tải Extension lên Marketplace

Bạn có thể tải extension lên thông qua 2 cách sau:

### Cách 1: Tải lên thủ công qua giao diện Web (Khuyên dùng cho lần đầu)

Đây là cách trực quan và dễ thực hiện nhất:

1. Truy cập trang quản trị nhà xuất bản: [Visual Studio Marketplace Management Portal](https://marketplace.visualstudio.com/manage).
2. Click vào tên **Publisher** của bạn.
3. Nhấp vào nút **New Extension** ở góc trên cùng bên trái và chọn **Visual Studio Code**.
4. Kéo và thả tệp `.vsix` vừa được tạo ra ở Bước 4 (ví dụ: `tool-support-claude-0.1.0.vsix`) vào vùng tải lên.
5. Đợi vài giây để Marketplace phân tích thông tin cấu hình từ tệp tin.
6. Sau khi tải lên thành công, extension của bạn sẽ ở trạng thái kiểm tra tự động (Verification). Trạng thái này thường mất từ 1 - 5 phút để hoàn tất. Khi chuyển sang trạng thái màu xanh lá cây, extension của bạn đã chính thức hoạt động trực tuyến trên chợ ứng dụng!

---

### Cách 2: Tải lên tự động qua Command Line (CLI)

Nếu bạn muốn thực hiện nhanh hoặc tích hợp vào hệ thống CI/CD:

1. Cài đặt công cụ dòng lệnh `vsce` của Microsoft trên máy tính (nếu chưa cài):
   ```bash
   npm install -g @vscode/vsce
   ```
2. Đăng nhập vào nhà xuất bản của bạn bằng Token PAT đã lấy ở Bước 2:
   ```bash
   vsce login <Publisher-ID-cua-ban>
   ```
   *Hệ thống sẽ hiển thị yêu cầu: `Enter personal access token:`. Hãy dán mã Token PAT của bạn vào và nhấn Enter.*
3. Thực hiện xuất bản trực tiếp mã nguồn hiện tại lên chợ ứng dụng:
   ```bash
   vsce publish
   ```
   *Lưu ý: Lệnh này sẽ tự động chạy biên dịch, đóng gói và tải trực tiếp lên chợ ứng dụng mà không cần bạn làm thủ công.*

Chúc bạn xuất bản ứng dụng thành công! Nếu gặp bất kỳ khó khăn nào trong quá trình thực hiện, hãy liên hệ qua trang hỗ trợ hoặc kiểm tra tài liệu chính thức của Microsoft về [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
