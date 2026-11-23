# gitlab-mcp

MCP server chạy local, chỉ đọc, để Claude đọc GitLab: merge request và bình luận review, lịch sử nhánh, nội dung file, và so sánh thay đổi.

## Cấu hình

`config.json` ở thư mục gốc (đã nằm trong `.gitignore` vì chứa token):

```json
{
    "gitlab_base_url": "https://gitlab.com",
    "gitlab_api_token": "<personal access token, scope read_api>"
}
```

- `gitlab_base_url`: địa chỉ GitLab của bạn. Bỏ trống thì dùng `https://gitlab.com`.
- `gitlab_api_token`: tạo ở GitLab > ảnh đại diện > Edit profile > Access tokens > Add new token, chỉ cần tick scope `read_api`. Không có token thì chỉ đọc được project công khai, và GitLab không cho đọc bình luận của merge request.

Có thể thay bằng biến môi trường `GITLAB_BASE_URL`, `GITLAB_API_TOKEN`, hoặc trỏ tới file khác bằng `GITLAB_CONFIG`.

## Kết nối Claude Desktop

File cấu hình: `~/Library/Application Support/Claude/claude_desktop_config.json`. Sửa xong thì thoát hẳn Claude Desktop (Cmd+Q) rồi mở lại.

### Cách 1: qua cổng HTTP (dùng khi project nằm trong Documents, Desktop hoặc Downloads)

macOS không cho Claude Desktop đọc file trong ba thư mục đó, nên bạn tự chạy server từ terminal và để Claude kết nối qua cổng:

```sh
npm run start:http                        # http://localhost:4101/mcp
node src/index.js --http --port 4200      # nếu muốn cổng khác (hoặc đặt GITLAB_MCP_PORT)
```

```json
"gitlab": {
  "command": "/Users/bizzidev/.nvm/versions/node/v22.23.2/bin/npx",
  "args": ["-y", "mcp-remote", "http://localhost:4101/mcp"],
  "env": {
    "PATH": "/Users/bizzidev/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin"
  }
}
```

Server phải đang chạy trước khi mở Claude Desktop. Nó chỉ nghe trên `127.0.0.1` và không yêu cầu xác thực, nên mọi chương trình trên máy này đều gọi được.

### Cách 2: stdio (Claude Desktop tự khởi chạy)

Cần project nằm ngoài ba thư mục trên, hoặc đã bật quyền cho Claude ở System Settings > Privacy & Security > Files and Folders.

```json
"gitlab": {
  "command": "/Users/bizzidev/.nvm/versions/node/v22.23.2/bin/node",
  "args": ["/đường/dẫn/tới/gitlab-mcp/src/index.js"]
}
```

## Tools

Tham số `project` nhận ID số, đường dẫn đầy đủ `nhóm/project`, hoặc URL bất kỳ bên trong project. Các tool về merge request nhận số IID, `!123` hoặc URL của merge request; khi truyền URL thì không cần `project`.

| Tool | Việc làm |
| --- | --- |
| `list_projects` | Tìm project, kèm ID và đường dẫn đầy đủ. |
| `list_merge_requests` | Tìm merge request theo trạng thái, nhánh nguồn/đích, tác giả, từ khoá, hoặc "của tôi / giao cho tôi / chờ tôi review". |
| `get_merge_request` | Tổng quan một merge request: trạng thái, nhánh, reviewer, người đã duyệt, khả năng merge, pipeline, mô tả, danh sách commit. |
| `get_merge_request_comments` | Bình luận review theo từng thread: file và dòng được bình luận, đoạn code tương ứng, trạng thái đã/chưa giải quyết, mọi câu trả lời. Lọc được theo thread chưa giải quyết hoặc theo file. |
| `get_merge_request_changes` | Diff của merge request: danh sách file thay đổi kèm số dòng thêm/xoá, rồi diff từng file. |
| `list_branches` | Danh sách nhánh, nhánh cập nhật gần nhất trước, kèm commit mới nhất. |
| `list_commits` | Lịch sử commit của một nhánh, tag hoặc commit; lọc theo file, tác giả, khoảng ngày. |
| `get_commit` | Chi tiết một commit và diff của nó. |
| `compare_refs` | So sánh hai nhánh, tag hoặc commit: các commit chênh nhau, file thay đổi, diff. |
| `get_file` | Đọc một file tại nhánh, tag hoặc commit bất kỳ, có số dòng; đọc được một khoảng dòng; ảnh (tối đa 700 KB) trả về dạng ảnh. |
| `list_files` | Liệt kê file và thư mục của repository. |

Diff lớn được cắt bớt để vừa một câu trả lời (khoảng 60.000 ký tự, mỗi file 15.000); phần chưa hiển thị được liệt kê ở cuối, gọi lại tool với `path` để xem riêng từng file hoặc thư mục.

## Thử nhanh

```sh
npm install
npm run inspect   # mở MCP Inspector trên trình duyệt để gọi thử từng tool
```
