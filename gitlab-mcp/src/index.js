#!/usr/bin/env node
// Read-only MCP server for GitLab: merge requests and their review comments,
// branch and commit history, repository files, and diffs.
//   node src/index.js          stdio: the MCP client spawns this process itself
//   node src/index.js --http   HTTP on 127.0.0.1: you start it, clients connect to the port
// In stdio mode stdout is reserved for the protocol, so all logging goes to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { GitLabClient, loadConfig } from "./client.js";
import {
  codeTarget,
  formatBranchLine,
  formatCommit,
  formatCommitLine,
  formatDiffs,
  formatMergeRequest,
  formatMergeRequestLine,
  formatProjectLine,
  formatThread,
  formatTreeEntry,
  isUnresolved,
  matchesPath,
  numberedLines,
  parseCommit,
  parseMergeRequest,
  parseProject,
  threadPosition,
} from "./format.js";

let client;
// Built on first use so a bad config surfaces as a readable tool error instead
// of the server dying before Claude Desktop can show anything.
function getClient() {
  client ??= new GitLabClient(loadConfig());
  return client;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// Upper bounds on what one tool call pulls from GitLab.
const MAX_DISCUSSIONS = 2000;
const MAX_DIFF_FILES = 1000;
const MAX_COMPARE_COMMITS = 100;
// Claude Desktop rejects tool results above roughly 1 MB, and base64 adds a third.
const MAX_IMAGE_BYTES = 700 * 1024;
const MAX_TEXT_CHARS = 50_000;
const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const projectArg = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe('Project: numeric ID, full path "group/subgroup/project", or any GitLab URL inside the project.');

const mergeRequestArgs = {
  merge_request: z
    .union([z.number().int().positive(), z.string().min(1)])
    .describe('Merge request: IID number, "!123", or the merge request URL copied from the browser.'),
  project: projectArg.optional().describe(
    'Project: numeric ID or full path "group/subgroup/project". Not needed when `merge_request` is a URL.',
  ),
};

const pathFilterArg = z
  .string()
  .optional()
  .describe("Only this file, or the files below this directory (path from the repository root).");

const pageArgs = (defaultLimit) => ({
  limit: z.number().int().min(1).max(100).default(defaultLimit).describe("Items per page."),
  page: z.number().int().min(1).default(1).describe("Page number, starting at 1."),
});

const TOOLS = [];
// Tools are collected here and registered on each McpServer that createServer()
// builds: stdio needs one server, stateless HTTP needs a fresh one per request.
function tool(name, config, handler) {
  TOOLS.push({ name, config, handler });
}

const projectPath = (project) => `/projects/${encodeURIComponent(project)}`;

const optional = (promise) => promise.catch(() => null);

/** "Tìm thấy 42 nhánh, đang hiển thị 1-20. Gọi lại với page=2 để xem tiếp." */
function pageSummary(noun, { items, total, nextPage }, { limit, page }) {
  const first = (page - 1) * limit + 1;
  const range = `${first}-${first + items.length - 1}`;
  const shown = total === null ? `Đang hiển thị ${noun} ${range}.` : `Tìm thấy ${total} ${noun}, đang hiển thị ${range}.`;
  return shown + (nextPage ? ` Gọi lại với page=${nextPage} để xem tiếp.` : "");
}

async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const worker = async () => {
    while (queue.length) await fn(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker));
}

/**
 * The lines of code each diff comment refers to, read from the file version the
 * comment was written on. Returns Map<discussion id, { first, lines }>; threads
 * whose file cannot be read (binary, deleted ref...) are simply left out.
 */
async function fetchSnippets(gl, project, threads) {
  const targets = new Map();
  const files = new Map();
  for (const thread of threads) {
    const target = codeTarget(threadPosition(thread));
    if (!target?.ref || !target.path) continue;
    targets.set(thread.id, target);
    files.set(`${target.ref}\n${target.path}`, null);
  }

  await mapLimit([...files.keys()], 6, async (key) => {
    const [ref, path] = key.split("\n");
    const data = await optional(
      gl.raw(`${projectPath(project)}/repository/files/${encodeURIComponent(path)}/raw`, { ref }),
    );
    if (data && !data.includes(0)) files.set(key, data.toString("utf8").split(/\r?\n/));
  });

  const snippets = new Map();
  for (const [id, target] of targets) {
    const lines = files.get(`${target.ref}\n${target.path}`);
    if (lines && target.last <= lines.length) {
      snippets.set(id, { first: target.first, lines: lines.slice(target.first - 1, target.last) });
    }
  }
  return snippets;
}

function createServer() {
  const server = new McpServer(
    { name: "gitlab", version: "1.0.0" },
    {
      instructions:
        "Read-only access to GitLab. When the user pastes a merge request URL or asks about a code " +
        "review, call get_merge_request for the overview, get_merge_request_comments for the review " +
        "threads and get_merge_request_changes for the diff. Use list_branches and list_commits for " +
        "branch history, compare_refs to diff two branches, tags or commits, and get_file / list_files " +
        "to read the repository at any ref. Use list_projects when the project path is unknown.",
    },
  );
  for (const { name, config, handler } of TOOLS) {
    server.registerTool(name, { ...config, annotations: READ_ONLY }, async (args) => {
      try {
        const result = await handler(args, getClient());
        return { content: typeof result === "string" ? [{ type: "text", text: result }] : result };
      } catch (err) {
        console.error(`[${name}] ${err.message}`);
        return { content: [{ type: "text", text: `Lỗi: ${err.message}` }], isError: true };
      }
    });
  }
  return server;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

tool(
  "list_projects",
  {
    title: "Danh sách project GitLab",
    description:
      "Find GitLab projects, most recently active first, with the ID and full path that the other " +
      "tools accept in their `project` argument.",
    inputSchema: {
      query: z.string().optional().describe("Only projects whose name or path contains this text."),
      membership: z
        .boolean()
        .default(true)
        .describe("Only projects the token's owner is a member of. Set false to search every visible project."),
      ...pageArgs(30),
    },
  },
  async ({ query, membership, limit, page }, gl) => {
    const search = query?.trim();
    // An anonymous client is a member of nothing; it can only browse public projects.
    const memberOnly = membership && Boolean(gl.token);
    const res = await gl.page("/projects", {
      simple: true,
      archived: false,
      membership: memberOnly,
      search,
      // Matching group names too is what makes "group/project" queries work, but
      // across every public project of gitlab.com it times out, so it is kept to
      // the member list unless the query cannot match without it.
      search_namespaces: search && (memberOnly || search.includes("/")) ? true : undefined,
      order_by: "last_activity_at",
      sort: "desc",
      per_page: limit,
      page,
    });
    if (!res.items.length) return "Không có project nào khớp.";
    return `${pageSummary("project", res, { limit, page })}\n\n${res.items.map(formatProjectLine).join("\n")}`;
  },
);

// ---------------------------------------------------------------------------
// Merge requests
// ---------------------------------------------------------------------------

tool(
  "list_merge_requests",
  {
    title: "Tìm merge request GitLab",
    description:
      "List merge requests, newest update first. Every filter is optional and they combine with AND. " +
      "Without `project` it searches every project the token can see. Returns one line per merge " +
      "request; call get_merge_request for details.",
    inputSchema: {
      project: projectArg.optional(),
      state: z.enum(["opened", "merged", "closed", "all"]).default("opened").describe("Which merge requests to include."),
      mine: z
        .enum(["all", "created", "assigned", "review"])
        .default("all")
        .describe(
          'Relation to the token\'s owner: "created" by me, "assigned" to me, waiting for my "review", or "all".',
        ),
      source_branch: z.string().optional().describe("Only merge requests from this branch."),
      target_branch: z.string().optional().describe("Only merge requests into this branch."),
      author_username: z.string().optional().describe("Only merge requests created by this username."),
      search: z.string().optional().describe("Text to look for in title and description."),
      ...pageArgs(20),
    },
  },
  async ({ project, state, mine, source_branch, target_branch, author_username, search, limit, page }, gl) => {
    const params = {
      state,
      scope: { created: "created_by_me", assigned: "assigned_to_me" }[mine] ?? "all",
      source_branch,
      target_branch,
      author_username,
      search: search?.trim(),
      order_by: "updated_at",
      sort: "desc",
      per_page: limit,
      page,
    };
    if (mine === "review") params.reviewer_username = (await gl.cached("/user")).username;

    const scoped = project !== undefined && project !== "";
    const path = scoped ? `${projectPath(parseProject(project, gl.baseUrl))}/merge_requests` : "/merge_requests";
    const res = await gl.page(path, params);
    if (!res.items.length) return "Không tìm thấy merge request nào khớp điều kiện.";

    const lines = res.items.map((mr) => formatMergeRequestLine(mr, { withProject: !scoped }));
    return `${pageSummary("merge request", res, { limit, page })}\n\n${lines.join("\n")}`;
  },
);

tool(
  "get_merge_request",
  {
    title: "Đọc merge request GitLab",
    description:
      "Overview of one merge request: state, branches, author, reviewers, approvals, merge status, " +
      "pipeline, full description and its commits. Review comments and the diff are separate: " +
      "get_merge_request_comments and get_merge_request_changes.",
    inputSchema: mergeRequestArgs,
  },
  async ({ project, merge_request }, gl) => {
    const ref = parseMergeRequest({ project, merge_request }, gl.baseUrl);
    const base = `${projectPath(ref.project)}/merge_requests/${ref.iid}`;
    const [mr, approvals, commits] = await Promise.all([
      gl.api(base),
      optional(gl.api(`${base}/approvals`)),
      optional(gl.all(`${base}/commits`, {}, 100)),
    ]);
    return formatMergeRequest(mr, { approvals, commits });
  },
);

tool(
  "get_merge_request_comments",
  {
    title: "Bình luận review của merge request",
    description:
      "Code review comments of a merge request, as threads in chronological order. Each inline " +
      "comment shows the file and line it is attached to, the lines of code it refers to, whether " +
      "the thread is resolved, and every reply. General (non-inline) comments are included too.",
    inputSchema: {
      ...mergeRequestArgs,
      only_unresolved: z.boolean().default(false).describe("Only threads that still need to be resolved."),
      path: pathFilterArg.describe(
        "Only inline comments on this file, or on files below this directory (path from the repository root).",
      ),
      include_code_context: z
        .boolean()
        .default(true)
        .describe("Show the commented lines of code above each inline comment."),
      include_system_notes: z
        .boolean()
        .default(false)
        .describe('Include GitLab\'s own activity notes ("added 2 commits", "approved this merge request"...).'),
      limit: z.number().int().min(1).max(200).default(50).describe("Threads per page."),
      page: z.number().int().min(1).default(1).describe("Page number, starting at 1."),
    },
  },
  async (args, gl) => {
    const { only_unresolved, path, include_code_context, include_system_notes, limit, page } = args;
    const ref = parseMergeRequest(args, gl.baseUrl);
    const base = `${projectPath(ref.project)}/merge_requests/${ref.iid}`;
    const [mr, discussions] = await Promise.all([gl.api(base), gl.all(`${base}/discussions`, {}, MAX_DISCUSSIONS)]);

    const threads = discussions.items
      .map((d) => ({ ...d, notes: include_system_notes ? d.notes : d.notes.filter((n) => !n.system) }))
      .filter((d) => d.notes.length);
    const heading = `# Bình luận review của !${mr.iid} ${mr.title}\n\n${mr.web_url}`;
    if (!threads.length) return `${heading}\n\nMerge request này chưa có bình luận nào.`;

    const inline = threads.filter(threadPosition).length;
    const counts =
      `Tổng ${threads.length} thread: ${inline} trên code, ${threads.length - inline} thảo luận chung; ` +
      `${threads.filter(isUnresolved).length} thread chưa giải quyết.` +
      (discussions.truncated ? ` (Chỉ đọc ${MAX_DISCUSSIONS} thread đầu tiên.)` : "");

    const matching = threads.filter((d) => {
      if (only_unresolved && !isUnresolved(d)) return false;
      const position = threadPosition(d);
      return !path?.trim() || (position && matchesPath(path, position.new_path, position.old_path));
    });
    const shown = matching.slice((page - 1) * limit, page * limit);
    if (!shown.length) {
      const why = matching.length ? `Trang ${page} không có thread nào.` : "Không có thread nào khớp bộ lọc.";
      return `${heading}\n\n${counts}\n\n${why}`;
    }

    const snippets = include_code_context ? await fetchSnippets(gl, ref.project, shown) : new Map();
    const blocks = shown.map((d) => formatThread(d, { snippet: snippets.get(d.id), headSha: mr.diff_refs?.head_sha }));

    const first = (page - 1) * limit + 1;
    const showing = matching.length < threads.length ? `${matching.length} thread khớp bộ lọc, đang` : "Đang";
    const more = page * limit < matching.length ? ` Gọi lại với page=${page + 1} để xem tiếp.` : "";
    const range = `${showing} hiển thị ${first}-${first + shown.length - 1}.${more}`;
    return `${heading}\n\n${counts} ${range}\n\n${blocks.join("\n\n")}`;
  },
);

tool(
  "get_merge_request_changes",
  {
    title: "Thay đổi (diff) của merge request",
    description:
      "What a merge request changes: the list of changed files with added/removed line counts, " +
      "then the unified diff of each file. Large merge requests do not fit in one answer: pass " +
      "`path` to read one file or directory at a time.",
    inputSchema: {
      ...mergeRequestArgs,
      path: pathFilterArg,
      include_diff: z
        .boolean()
        .default(true)
        .describe("Include the diff text. Set false for only the list of changed files."),
    },
  },
  async ({ project, merge_request, path, include_diff }, gl) => {
    const ref = parseMergeRequest({ project, merge_request }, gl.baseUrl);
    const base = `${projectPath(ref.project)}/merge_requests/${ref.iid}`;
    const [mr, diffs] = await Promise.all([gl.api(base), gl.all(`${base}/diffs`, {}, MAX_DIFF_FILES)]);

    const out = [
      `# Thay đổi của !${mr.iid} ${mr.title}`,
      `${mr.web_url}\n\n\`${mr.source_branch}\` → \`${mr.target_branch}\``,
      formatDiffs(diffs.items, { path: path?.trim(), includeDiff: include_diff }),
    ];
    if (diffs.truncated) out.push(`_(Chỉ đọc ${MAX_DIFF_FILES} file thay đổi đầu tiên.)_`);
    return out.join("\n\n");
  },
);

// ---------------------------------------------------------------------------
// Branches and commits
// ---------------------------------------------------------------------------

tool(
  "list_branches",
  {
    title: "Danh sách nhánh GitLab",
    description:
      "Branches of a project, most recently updated first, each with its latest commit and whether " +
      "it is the default branch, protected, or already merged. Use list_commits for the history of one branch.",
    inputSchema: {
      project: projectArg,
      query: z
        .string()
        .optional()
        .describe('Only branches whose name contains this text. "^feature" matches a prefix, "fix$" a suffix.'),
      ...pageArgs(30),
    },
  },
  async ({ project, query, limit, page }, gl) => {
    const res = await gl.page(`${projectPath(parseProject(project, gl.baseUrl))}/repository/branches`, {
      search: query?.trim(),
      sort: "updated_desc",
      per_page: limit,
      page,
    });
    if (!res.items.length) return "Không có nhánh nào khớp.";
    return `${pageSummary("nhánh", res, { limit, page })}\n\n${res.items.map(formatBranchLine).join("\n")}`;
  },
);

tool(
  "list_commits",
  {
    title: "Lịch sử commit của nhánh",
    description:
      "Commit history of a branch, tag or commit, newest first. Narrow it to one file or directory " +
      "with `path`, to one author, or to a date range. Call get_commit to see what a commit changed.",
    inputSchema: {
      project: projectArg,
      ref: z.string().optional().describe("Branch, tag or commit SHA to read history from. Defaults to the default branch."),
      path: z.string().optional().describe("Only commits that touched this file or directory."),
      author: z.string().optional().describe("Only commits whose author name or email contains this text."),
      since: z.string().optional().describe("Only commits on or after this ISO 8601 date, e.g. 2025-01-31 or 2025-01-31T08:00:00Z."),
      until: z.string().optional().describe("Only commits on or before this ISO 8601 date."),
      with_stats: z.boolean().default(false).describe("Include added/removed line counts for each commit."),
      ...pageArgs(30),
    },
  },
  async ({ project, ref, path, author, since, until, with_stats, limit, page }, gl) => {
    const res = await gl.page(`${projectPath(parseProject(project, gl.baseUrl))}/repository/commits`, {
      ref_name: ref?.trim(),
      path: path?.trim(),
      author: author?.trim(),
      since,
      until,
      with_stats,
      per_page: limit,
      page,
    });
    if (!res.items.length) return page > 1 ? "Không còn commit nào ở trang này." : "Không có commit nào khớp điều kiện.";

    const where = [ref?.trim() ? `\`${ref.trim()}\`` : "nhánh mặc định", path?.trim() ? `file \`${path.trim()}\`` : null]
      .filter(Boolean)
      .join(", ");
    return (
      `# Lịch sử commit của ${where}\n\n${pageSummary("commit", res, { limit, page })}\n\n` +
      res.items.map(formatCommitLine).join("\n")
    );
  },
);

tool(
  "get_commit",
  {
    title: "Đọc commit GitLab",
    description:
      "One commit: author, dates, parents, full message, the files it changed and their diff. " +
      "Pass `path` to see only one file or directory of a large commit.",
    inputSchema: {
      sha: z.string().min(1).describe("Commit SHA (full or short), a branch or tag name for its latest commit, or a commit URL."),
      project: projectArg.optional().describe(
        'Project: numeric ID or full path "group/subgroup/project". Not needed when `sha` is a URL.',
      ),
      path: pathFilterArg,
      include_diff: z
        .boolean()
        .default(true)
        .describe("Include the diff text. Set false for only the list of changed files."),
    },
  },
  async ({ project, sha, path, include_diff }, gl) => {
    const ref = parseCommit({ project, sha }, gl.baseUrl);
    const base = `${projectPath(ref.project)}/repository/commits/${encodeURIComponent(ref.sha)}`;
    const [commit, diffs] = await Promise.all([gl.api(base), gl.all(`${base}/diff`, {}, MAX_DIFF_FILES)]);

    const out = [formatCommit(commit), formatDiffs(diffs.items, { path: path?.trim(), includeDiff: include_diff })];
    if (diffs.truncated) out.push(`_(Chỉ đọc ${MAX_DIFF_FILES} file thay đổi đầu tiên.)_`);
    return out.join("\n\n");
  },
);

tool(
  "compare_refs",
  {
    title: "So sánh hai nhánh, tag hoặc commit",
    description:
      "Compare two branches, tags or commits of a project: the commits that `to` has and `from` " +
      "does not, the changed files with line counts, and the diff. By default it shows what `to` " +
      "changed since it diverged from `from` (like a merge request from `to` into `from`).",
    inputSchema: {
      project: projectArg,
      from: z.string().min(1).describe("Base: branch, tag or commit SHA to compare against (e.g. main)."),
      to: z.string().min(1).describe("Head: branch, tag or commit SHA whose changes to show (e.g. a feature branch)."),
      straight: z
        .boolean()
        .default(false)
        .describe(
          "false: diff from the common ancestor of the two refs to `to` (git diff from...to). " +
            "true: diff the two refs directly (git diff from..to), which also shows what only `from` has, reversed.",
        ),
      path: pathFilterArg,
      include_diff: z
        .boolean()
        .default(true)
        .describe("Include the diff text. Set false for only the commits and the list of changed files."),
    },
  },
  async ({ project, from, to, straight, path, include_diff }, gl) => {
    const data = await gl.api(`${projectPath(parseProject(project, gl.baseUrl))}/repository/compare`, {
      from: from.trim(),
      to: to.trim(),
      straight,
    });

    const out = [`# So sánh \`${from.trim()}\` → \`${to.trim()}\``];
    if (data.web_url) out.push(data.web_url);
    if (data.compare_same_ref) return [...out, "Hai ref trỏ tới cùng một commit: không có gì khác nhau."].join("\n\n");

    const commits = data.commits ?? [];
    if (commits.length) {
      // GitLab lists them oldest first; show the newest, in the order list_commits uses.
      const shown = commits.slice(-MAX_COMPARE_COMMITS).reverse();
      const count = shown.length < commits.length ? `${shown.length} mới nhất trên tổng ${commits.length}` : commits.length;
      out.push(
        `## Commit có ở \`${to.trim()}\` mà chưa có ở \`${from.trim()}\` (${count}, mới nhất trước)\n\n` +
          shown.map(formatCommitLine).join("\n"),
      );
    } else {
      out.push(`\`${to.trim()}\` không có commit nào mà \`${from.trim()}\` chưa có.`);
    }

    out.push(formatDiffs(data.diffs ?? [], { path: path?.trim(), includeDiff: include_diff }));
    if (data.compare_timeout) out.push("_(GitLab hết thời gian khi tính diff nên danh sách thay đổi có thể thiếu.)_");
    return out.join("\n\n");
  },
);

// ---------------------------------------------------------------------------
// Repository files
// ---------------------------------------------------------------------------

tool(
  "get_file",
  {
    title: "Đọc file trong repository",
    description:
      "Read one file of a repository at any branch, tag or commit, with line numbers. Images are " +
      "returned as an image you can look at. Use `start_line` / `end_line` to read part of a large " +
      "file, e.g. the lines around a review comment.",
    inputSchema: {
      project: projectArg,
      path: z.string().min(1).describe("File path from the repository root, e.g. src/app/main.ts."),
      ref: z.string().optional().describe("Branch, tag or commit SHA. Defaults to the default branch."),
      start_line: z.number().int().min(1).optional().describe("First line to return (1-based)."),
      end_line: z.number().int().min(1).optional().describe("Last line to return (inclusive)."),
    },
  },
  async ({ project, path, ref, start_line, end_line }, gl) => {
    const filePath = path.trim().replace(/^\.?\/+/, "");
    const file = await gl.api(
      `${projectPath(parseProject(project, gl.baseUrl))}/repository/files/${encodeURIComponent(filePath)}`,
      { ref: ref?.trim() || "HEAD" },
    );
    const data = Buffer.from(file.content ?? "", file.encoding === "base64" ? "base64" : "utf8");

    const at = ref?.trim() ? `\`${ref.trim()}\`` : "nhánh mặc định";
    const sizeKb = Math.ceil((file.size ?? data.length) / 1024);
    const label = `# \`${file.file_path}\` tại ${at}\n\n- **Kích thước:** ${sizeKb} KB\n- **Commit cuối sửa file:** \`${file.last_commit_id}\``;

    const imageType = IMAGE_TYPES[filePath.split(".").pop().toLowerCase()];
    if (imageType) {
      if (data.length > MAX_IMAGE_BYTES) {
        return `${label}\n\nẢnh lớn hơn giới hạn ${MAX_IMAGE_BYTES / 1024} KB nên không gửi được qua MCP. Mở trực tiếp trên GitLab để xem.`;
      }
      return [
        { type: "text", text: label },
        { type: "image", data: data.toString("base64"), mimeType: imageType },
      ];
    }
    if (data.includes(0)) return `${label}\n\nĐây là file nhị phân, không đọc được qua MCP.`;
    if (!data.length) return `${label}\n\nFile rỗng.`;

    const lines = data.toString("utf8").replace(/\r?\n$/, "").split(/\r?\n/);
    const first = start_line ?? 1;
    if (first > lines.length) return `${label}\n\nFile chỉ có ${lines.length} dòng, không có dòng ${first}.`;
    let last = Math.min(end_line ?? lines.length, lines.length);
    if (last < first) throw new Error("end_line phải lớn hơn hoặc bằng start_line.");

    // Stop at the size limit on a line boundary; the caller can ask for the next range.
    let chars = 0;
    for (let i = first; i <= last; i++) {
      chars += lines[i - 1].length + 1;
      if (chars > MAX_TEXT_CHARS && i > first) {
        last = i - 1;
        break;
      }
    }
    const requestedLast = Math.min(end_line ?? lines.length, lines.length);
    const range =
      first === 1 && last === lines.length
        ? `${lines.length} dòng`
        : `dòng ${first}-${last} trên tổng ${lines.length} dòng`;
    const cut =
      last < requestedLast ? `\n\n_(Đã cắt vì quá dài. Gọi lại với start_line=${last + 1} để đọc tiếp.)_` : "";
    return `${label}\n- **Hiển thị:** ${range}\n\n${numberedLines(lines.slice(first - 1, last), first)}${cut}`;
  },
);

tool(
  "list_files",
  {
    title: "Danh sách file trong repository",
    description:
      "List the files and directories of a repository at any branch, tag or commit. Directories " +
      "end with a slash. Use it to find the path to pass to get_file.",
    inputSchema: {
      project: projectArg,
      path: z.string().optional().describe("Directory to list, from the repository root. Defaults to the root."),
      ref: z.string().optional().describe("Branch, tag or commit SHA. Defaults to the default branch."),
      recursive: z.boolean().default(false).describe("Also list everything inside subdirectories."),
      ...pageArgs(100),
    },
  },
  async ({ project, path, ref, recursive, limit, page }, gl) => {
    const res = await gl.page(`${projectPath(parseProject(project, gl.baseUrl))}/repository/tree`, {
      path: path?.trim().replace(/^\.?\/+|\/+$/g, ""),
      ref: ref?.trim(),
      recursive,
      per_page: limit,
      page,
    });
    if (!res.items.length) return page > 1 ? "Không còn mục nào ở trang này." : "Thư mục trống.";
    return `${pageSummary("mục", res, { limit, page })}\n\n${res.items.map(formatTreeEntry).join("\n")}`;
  },
);

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

async function runStdio() {
  await createServer().connect(new StdioServerTransport());
  console.error("GitLab MCP server đang chạy (stdio).");
}

async function runHttp(port) {
  const { createMcpExpressApp } = await import("@modelcontextprotocol/sdk/server/express.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

  // Fail at startup, where the person running it sees the message, not on the first tool call.
  try {
    const gl = getClient();
    if (!gl.token) console.error("Chưa cấu hình gitlab_api_token: chỉ đọc được project công khai.");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  // Bound to loopback only; the SDK app also rejects foreign Host headers (DNS rebinding).
  const app = createMcpExpressApp({ host: "127.0.0.1" });

  app.post("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[http] ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // Stateless server: no SSE stream to open and no session to delete.
  app.all("/mcp", (_req, res) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  });

  // Express 5 hands listen errors (port taken...) to this same callback.
  app.listen(port, "127.0.0.1", (err) => {
    if (!err) {
      console.error(`GitLab MCP server đang chạy tại http://localhost:${port}/mcp (Ctrl+C để dừng)`);
      return;
    }
    console.error(
      err.code === "EADDRINUSE"
        ? `Cổng ${port} đang được dùng. Chọn cổng khác: node src/index.js --http --port <số>`
        : `Không mở được cổng ${port}: ${err.message}`,
    );
    process.exit(1);
  });
}

const args = process.argv.slice(2);
const portFlag = args.indexOf("--port");
if (args.includes("--http") || portFlag !== -1) {
  const port = Number(portFlag !== -1 ? args[portFlag + 1] : process.env.GITLAB_MCP_PORT || 4101);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Cổng không hợp lệ. Ví dụ: node src/index.js --http --port 4101");
    process.exit(1);
  }
  await runHttp(port);
} else {
  await runStdio();
}
