# open-project-mcp

MCP server chạy local (stdio), chỉ đọc, để Claude Desktop đọc ticket OpenProject.

## Cấu hình

`config.json` ở thư mục gốc (đã nằm trong `.gitignore` vì chứa token):

```json
{
    "open_project_base_url": "https://projects.example.com",
    "open_project_api_token": "<token lấy ở My account > Access tokens > API>"
}
```

Có thể thay bằng biến môi trường `OPENPROJECT_BASE_URL`, `OPENPROJECT_API_TOKEN`, hoặc trỏ tới file khác bằng `OPENPROJECT_CONFIG`.

## Kết nối Claude Desktop

File cấu hình: `~/Library/Application Support/Claude/claude_desktop_config.json`. Sửa xong thì thoát hẳn Claude Desktop (Cmd+Q) rồi mở lại.

### Cách 1: qua cổng HTTP (dùng khi project nằm trong Documents, Desktop hoặc Downloads)

macOS không cho Claude Desktop đọc file trong ba thư mục đó, nên bạn tự chạy server từ terminal và để Claude kết nối qua cổng:

```sh
npm run start:http                        # http://localhost:4100/mcp
node src/index.js --http --port 4200      # nếu muốn cổng khác
```

```json
"openproject": {
  "command": "/Users/bizzidev/.nvm/versions/node/v22.23.2/bin/npx",
  "args": ["-y", "mcp-remote", "http://localhost:4100/mcp"],
  "env": {
    "PATH": "/Users/bizzidev/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin"
  }
}
```

Server phải đang chạy trước khi mở Claude Desktop. Nó chỉ nghe trên `127.0.0.1` và không yêu cầu xác thực, nên mọi chương trình trên máy này đều gọi được.

### Cách 2: stdio (Claude Desktop tự khởi chạy)

Cần project nằm ngoài ba thư mục trên, hoặc đã bật quyền cho Claude ở System Settings > Privacy & Security > Files and Folders.

```json
"openproject": {
  "command": "/Users/bizzidev/.nvm/versions/node/v22.23.2/bin/node",
  "args": ["/đường/dẫn/tới/open-project-mcp/src/index.js"]
}
```

## Tools

| Tool | Việc làm |
| --- | --- |
| `get_work_package` | Đọc trọn một ticket: thông tin, trường tuỳ chỉnh, mô tả, ticket cha/con, liên kết, tệp đính kèm, bình luận. Nhận ID, `#123` hoặc URL ticket. |
| `get_work_package_activity` | Lịch sử ticket: bình luận và các lần đổi trạng thái, người nhận, ngày. |
| `get_attachment` | Xem ảnh chụp màn hình (tối đa 700 KB) hoặc tệp văn bản đính kèm. |
| `search_work_packages` | Tìm ticket theo từ khoá, dự án, trạng thái, "giao cho tôi". |
| `list_projects` | Danh sách dự án kèm ID và identifier. |

## Thử nhanh

```sh
npm install
npm run inspect   # mở MCP Inspector trên trình duyệt để gọi thử từng tool
```
