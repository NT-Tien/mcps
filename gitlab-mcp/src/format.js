// Turns what users paste (IDs, paths, URLs) into GitLab API identifiers, and
// GitLab REST JSON into compact Markdown that reads well as LLM context.

// Diffs are the bulk of any answer; these keep one tool result well below the
// roughly 1 MB that Claude Desktop accepts, and readable.
const MAX_DIFF_CHARS = 60_000;
const MAX_FILE_DIFF_CHARS = 15_000;
const MAX_SKIPPED_NAMES = 20;
// Lines of code shown above the commented line of a review comment.
const CONTEXT_LINES = 3;
const MAX_SNIPPET_LINES = 30;

const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : null);

const dateTime = (iso) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : null);

const person = (user) => (user ? `${user.name} (@${user.username})` : null);

const people = (users) => (users?.length ? users.map(person).join(", ") : null);

function field(label, value) {
  return value === null || value === undefined || value === "" ? null : `- **${label}:** ${value}`;
}

/** Code fence that survives content which itself contains backtick fences. */
function fence(text, lang = "") {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 2);
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${lang}\n${text.replace(/\n+$/, "")}\n${ticks}`;
}

export function numberedLines(lines, first) {
  const width = String(first + lines.length - 1).length;
  return fence(lines.map((line, i) => `${String(first + i).padStart(width)} | ${line}`).join("\n"));
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const SECTION = "merge_requests|commits?|tree|blob|blame|raw|compare|branches|tags|pipelines|issues";

/**
 * Splits a GitLab web URL into the project path and the page inside it:
 * ".../group/app/-/merge_requests/12/diffs" -> { project: "group/app", section: "merge_requests", rest: "12/diffs" }.
 */
function splitWebUrl(text, baseUrl) {
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`URL không hợp lệ: "${text}".`);
  }
  const base = new URL(baseUrl);
  if (url.host !== base.host) {
    throw new Error(`URL thuộc ${url.host}, nhưng server đang cấu hình cho ${base.host} (gitlab_base_url).`);
  }

  let path = decodeURIComponent(url.pathname);
  // GitLab may be installed below a sub-path (https://host/gitlab).
  const prefix = base.pathname.replace(/\/+$/, "");
  if (prefix && path.startsWith(`${prefix}/`)) path = path.slice(prefix.length);

  let project = path;
  let page = "";
  const dash = path.indexOf("/-/");
  if (dash !== -1) {
    project = path.slice(0, dash);
    page = path.slice(dash + 3);
  } else {
    // URLs from before GitLab added the "/-/" separator.
    const legacy = path.match(new RegExp(`/((?:${SECTION})(?:/.*)?)$`));
    if (legacy) {
      project = path.slice(0, legacy.index);
      page = legacy[1];
    }
  }

  const [, section = null, rest = ""] = page.match(new RegExp(`^(${SECTION})(?:/(.*))?$`)) ?? [];
  return { project: project.replace(/^\/+|\/+$/g, "").replace(/\.git$/, ""), section, rest };
}

const isWebUrl = (text) => /^https?:\/\//i.test(text);

/** Accepts 12, "12", "group/sub/project", a web URL inside the project, or a clone URL. */
export function parseProject(input, baseUrl) {
  const text = String(input ?? "").trim();
  if (/^\d+$/.test(text)) return text;

  const path = isWebUrl(text)
    ? splitWebUrl(text, baseUrl).project
    : text
        .replace(/^(?:ssh:\/\/)?git@[^:/]+[:/]/, "")
        .replace(/^\/+|\/+$/g, "")
        .replace(/\.git$/, "");
  if (!path.includes("/")) {
    throw new Error(
      `Không nhận ra project từ "${text}". Hãy truyền ID số, đường dẫn đầy đủ "nhóm/project" hoặc URL của project; ` +
        "dùng list_projects để tra.",
    );
  }
  return path;
}

/** Accepts an IID (12, "!12") with a project, a "group/project!12" reference, or the merge request URL. */
export function parseMergeRequest({ project, merge_request }, baseUrl) {
  const text = String(merge_request).trim();

  const plain = text.match(/^!?(\d+)$/);
  if (plain) {
    if (project === undefined || project === "") {
      throw new Error("Thiếu `project`: chỉ bỏ qua được khi `merge_request` là URL của merge request.");
    }
    return { project: parseProject(project, baseUrl), iid: plain[1] };
  }

  if (isWebUrl(text)) {
    const url = splitWebUrl(text, baseUrl);
    const iid = url.section === "merge_requests" ? url.rest.match(/^(\d+)/)?.[1] : null;
    if (iid) return { project: url.project, iid };
  } else {
    const reference = text.match(/^(.+)!(\d+)$/);
    if (reference) return { project: parseProject(reference[1], baseUrl), iid: reference[2] };
  }

  throw new Error(
    `Không nhận ra merge request từ "${text}". Hãy truyền số IID, "!123" hoặc URL của merge request.`,
  );
}

/** Accepts a SHA, branch or tag name with a project, or a commit URL. */
export function parseCommit({ project, sha }, baseUrl) {
  const text = String(sha).trim();
  if (isWebUrl(text)) {
    const url = splitWebUrl(text, baseUrl);
    const id = /^commits?$/.test(url.section ?? "") ? url.rest.split(/[/?#]/)[0] : null;
    if (!id) throw new Error(`Không nhận ra commit từ "${text}". Hãy truyền SHA hoặc URL của commit.`);
    return { project: url.project, sha: id };
  }
  if (project === undefined || project === "") {
    throw new Error("Thiếu `project`: chỉ bỏ qua được khi `sha` là URL của commit.");
  }
  return { project: parseProject(project, baseUrl), sha: text };
}

// ---------------------------------------------------------------------------
// Projects, branches, commits, files
// ---------------------------------------------------------------------------

export function formatProjectLine(p) {
  const meta = [
    `id ${p.id}`,
    p.default_branch ? `nhánh mặc định \`${p.default_branch}\`` : null,
    p.last_activity_at ? `hoạt động gần nhất ${day(p.last_activity_at)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const description = p.description?.trim().replace(/\s+/g, " ");
  const about = description ? `. ${description.length > 120 ? `${description.slice(0, 120)}…` : description}` : "";
  return `- **${p.path_with_namespace}**: ${meta}${about}`;
}

export function formatBranchLine(b) {
  const tags = [b.default ? "mặc định" : null, b.protected ? "protected" : null, b.merged ? "đã merge" : null]
    .filter(Boolean)
    .join(" · ");
  const c = b.commit;
  const last = c ? `: \`${c.short_id}\` ${day(c.committed_date)} ${c.author_name}: ${c.title}` : "";
  return `- **${b.name}**${tags ? ` [${tags}]` : ""}${last}`;
}

export function formatCommitLine(c) {
  const stats = c.stats ? ` (+${c.stats.additions} −${c.stats.deletions})` : "";
  const merge = c.parent_ids?.length > 1 ? " [merge]" : "";
  return `- \`${c.short_id}\` ${dateTime(c.committed_date || c.created_at)} ${c.author_name}: ${c.title}${merge}${stats}`;
}

export function formatCommit(c) {
  const out = [`# Commit \`${c.id}\``, c.web_url];
  out.push(
    [
      field("Tiêu đề", c.title),
      field("Tác giả", c.author_name),
      field("Ngày viết", dateTime(c.authored_date)),
      c.committer_name && c.committer_name !== c.author_name ? field("Người commit", c.committer_name) : null,
      field("Ngày commit", dateTime(c.committed_date)),
      field("Commit cha", c.parent_ids?.map((id) => `\`${id.slice(0, 8)}\``).join(", ")),
      c.stats ? field("Số dòng", `+${c.stats.additions} −${c.stats.deletions}`) : null,
      field("Pipeline", c.last_pipeline?.status),
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const body = c.message?.trim();
  if (body && body !== c.title?.trim()) out.push(`## Nội dung commit\n\n${body}`);
  return out.filter(Boolean).join("\n\n");
}

export function formatTreeEntry(entry) {
  if (entry.type === "tree") return `- \`${entry.path}/\``;
  return `- \`${entry.path}\`${entry.type === "commit" ? " (submodule)" : ""}`;
}

// ---------------------------------------------------------------------------
// Merge requests
// ---------------------------------------------------------------------------

const STATE = { opened: "đang mở", merged: "đã merge", closed: "đã đóng", locked: "đang khoá" };

const isDraft = (mr) => mr.draft ?? mr.work_in_progress ?? false;

export function formatMergeRequestLine(mr, { withProject = false } = {}) {
  const tags = [STATE[mr.state] || mr.state, isDraft(mr) ? "draft" : null, mr.has_conflicts ? "conflict" : null]
    .filter(Boolean)
    .join(" · ");
  const ref = (withProject && mr.references?.full) || `!${mr.iid}`;
  const meta = [
    `\`${mr.source_branch}\` → \`${mr.target_branch}\``,
    mr.author ? `tác giả ${mr.author.name}` : null,
    mr.reviewers?.length ? `reviewer ${mr.reviewers.map((u) => u.name).join(", ")}` : null,
    mr.user_notes_count ? `${mr.user_notes_count} bình luận` : null,
    `cập nhật ${day(mr.updated_at)}`,
  ]
    .filter(Boolean)
    .join(", ");
  return `- **${ref}** [${tags}] ${mr.title}: ${meta}`;
}

export function formatMergeRequest(mr, { approvals, commits }) {
  const out = [`# !${mr.iid} ${mr.title}`, mr.web_url];

  const state = [STATE[mr.state] || mr.state, isDraft(mr) ? "draft" : null].filter(Boolean).join(", ");
  const comments =
    mr.user_notes_count === undefined
      ? null
      : `${mr.user_notes_count}${mr.blocking_discussions_resolved === false ? " (còn thread chưa giải quyết)" : ""}`;
  const mergedBy = mr.merge_user || mr.merged_by;

  out.push(
    [
      field("Trạng thái", state),
      field("Nhánh", `\`${mr.source_branch}\` → \`${mr.target_branch}\``),
      field("Tác giả", person(mr.author)),
      field("Người được giao", people(mr.assignees)),
      field("Reviewer", people(mr.reviewers)),
      field("Đã duyệt bởi", people(approvals?.approved_by?.map((a) => a.user))),
      field("Nhãn", mr.labels?.join(", ")),
      field("Milestone", mr.milestone?.title),
      field("Khả năng merge", mr.detailed_merge_status || mr.merge_status),
      field("Conflict", mr.has_conflicts ? "có" : null),
      field("Pipeline", mr.head_pipeline?.status),
      field("Số file thay đổi", mr.changes_count),
      field("Bình luận", comments),
      field("Tạo lúc", dateTime(mr.created_at)),
      field("Cập nhật lúc", dateTime(mr.updated_at)),
      field("Merge lúc", mr.merged_at ? `${dateTime(mr.merged_at)}${mergedBy ? `, bởi ${mergedBy.name}` : ""}` : null),
      field("Đóng lúc", dateTime(mr.closed_at)),
      field("Commit đầu nhánh", mr.sha ? `\`${mr.sha}\`` : null),
      field("Commit gốc so sánh", mr.diff_refs?.base_sha ? `\`${mr.diff_refs.base_sha}\`` : null),
    ]
      .filter(Boolean)
      .join("\n"),
  );

  out.push(`## Mô tả\n\n${mr.description?.trim() || "_(không có mô tả)_"}`);

  if (commits?.items.length) {
    const count = commits.truncated ? `${commits.items.length} mới nhất` : commits.items.length;
    out.push(`## Commit (${count}, mới nhất trước)\n\n${commits.items.map(formatCommitLine).join("\n")}`);
  }

  out.push(
    "Dùng get_merge_request_comments để đọc bình luận review, get_merge_request_changes để xem diff.",
  );
  return out.filter(Boolean).join("\n\n");
}

// ---------------------------------------------------------------------------
// Review comments
// ---------------------------------------------------------------------------

export const isUnresolved = (discussion) => discussion.notes.some((n) => n.resolvable && !n.resolved);

/** The diff position a thread is attached to, or null for a general comment. */
export const threadPosition = (discussion) => discussion.notes[0]?.position ?? null;

/**
 * Which file version and lines to show above a diff comment. Comments on a
 * removed line point at the old file (base_sha), everything else at the new one.
 */
export function codeTarget(position) {
  if (position?.position_type !== "text") return null;
  const side = position.new_line != null ? "new" : "old";
  const line = position[`${side}_line`];
  if (line == null) return null;

  // Multi-line comments carry the first line of their range.
  const rangeStart = position.line_range?.start?.[`${side}_line`];
  const first =
    rangeStart && rangeStart < line
      ? Math.max(rangeStart, line - MAX_SNIPPET_LINES + 1)
      : Math.max(1, line - CONTEXT_LINES);
  return {
    ref: side === "new" ? position.head_sha : position.base_sha,
    path: side === "new" ? position.new_path : position.old_path,
    first,
    last: line,
  };
}

function threadLocation(position) {
  if (!position) return "Thảo luận chung";
  const { new_line: newLine, old_line: oldLine } = position;
  if (position.position_type === "file") return `\`${position.new_path || position.old_path}\` (cả file)`;
  if (position.position_type === "image") return `\`${position.new_path || position.old_path}\` (trên ảnh)`;

  if (newLine != null) {
    const start = position.line_range?.start?.new_line;
    const lines = start && start < newLine ? `dòng ${start}-${newLine}` : `dòng ${newLine}`;
    return `\`${position.new_path}\` ${lines}${oldLine == null ? " (dòng thêm mới)" : ""}`;
  }
  if (oldLine != null) return `\`${position.old_path}\` dòng ${oldLine} của bản cũ (dòng bị xoá)`;
  return `\`${position.new_path || position.old_path}\``;
}

function threadState(notes) {
  const resolvable = notes.filter((n) => n.resolvable);
  if (!resolvable.length) return null;
  if (resolvable.some((n) => !n.resolved)) return "chưa giải quyết";
  const by = resolvable.find((n) => n.resolved_by)?.resolved_by.name;
  return by ? `đã giải quyết bởi ${by}` : "đã giải quyết";
}

/**
 * One review thread: where it is attached, the code it refers to, then every
 * note in order. `snippet` is { first, lines } from the commented file version.
 */
export function formatThread(discussion, { snippet, headSha } = {}) {
  const position = threadPosition(discussion);
  // GitLab moves a comment along when new commits arrive, unless the line it
  // was written on changed: then the position stays on the old version.
  const outdated = position?.head_sha && headSha && position.head_sha !== headSha;
  const heading = [
    threadLocation(position),
    threadState(discussion.notes),
    outdated ? "code đã đổi sau bình luận này" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const parts = [`### ${heading}`];
  if (snippet) parts.push(numberedLines(snippet.lines, snippet.first));
  for (const note of discussion.notes) {
    const who = note.system ? `_${note.author?.name} (hệ thống)_` : `**${note.author?.name}** (@${note.author?.username})`;
    parts.push(`${who}, ${dateTime(note.created_at)}:\n\n${note.body?.trim()}`);
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

function diffStat(diff) {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (!inHunk) continue;
    else if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function diffFileLabel(d) {
  if (d.new_file) return `[thêm] \`${d.new_path}\``;
  if (d.deleted_file) return `[xoá] \`${d.old_path}\``;
  if (d.renamed_file) return `[đổi tên] \`${d.old_path}\` → \`${d.new_path}\``;
  return `[sửa] \`${d.new_path}\``;
}

const cleanPath = (path) => path.trim().replace(/^\.?\/+|\/+$/g, "");

/** True when the entry is the file `filter`, or lies inside the directory `filter`. */
export function matchesPath(filter, ...paths) {
  const want = cleanPath(filter);
  return paths.some((p) => p === want || p?.startsWith(`${want}/`));
}

/**
 * A list of changed files with line counts, then the diffs themselves until
 * the size budget runs out. `path` narrows both to one file or directory.
 */
export function formatDiffs(diffs, { path, includeDiff = true } = {}) {
  const files = path ? diffs.filter((d) => matchesPath(path, d.new_path, d.old_path)) : diffs;
  if (!files.length) {
    return path
      ? `_(không có file thay đổi nào khớp \`${cleanPath(path)}\` trong ${diffs.length} file thay đổi)_`
      : "_(không có thay đổi nào)_";
  }

  const stats = files.map((d) => diffStat(d.diff || ""));
  const added = stats.reduce((sum, s) => sum + s.added, 0);
  const removed = stats.reduce((sum, s) => sum + s.removed, 0);
  const list = files.map((d, i) => {
    const note = d.diff
      ? `(+${stats[i].added} −${stats[i].removed})`
      : d.too_large || d.collapsed
        ? "(GitLab không trả diff vì quá lớn)"
        : "(không có diff dạng văn bản: file nhị phân hoặc chỉ đổi tên/quyền)";
    return `- ${diffFileLabel(d)} ${note}`;
  });
  const out = [`## File thay đổi (${files.length} file, +${added} −${removed})\n\n${list.join("\n")}`];
  if (!includeDiff) return out[0];

  const perFile = files.length === 1 ? MAX_DIFF_CHARS : MAX_FILE_DIFF_CHARS;
  let budget = MAX_DIFF_CHARS;
  const skipped = [];
  for (const d of files) {
    if (!d.diff) continue;
    const name = d.deleted_file ? d.old_path : d.new_path;
    const size = Math.min(d.diff.length, perFile);
    if (size > budget) {
      skipped.push(name);
      continue;
    }
    budget -= size;

    let text = d.diff;
    let cut = "";
    if (text.length > perFile) {
      text = text.slice(0, text.lastIndexOf("\n", perFile) + 1 || perFile);
      cut = `\n\n_(diff của file này đã cắt: hiển thị ${text.length} trên ${d.diff.length} ký tự)_`;
    }
    out.push(`### ${diffFileLabel(d)}\n\n${fence(text, "diff")}${cut}`);
  }

  if (skipped.length) {
    const names = skipped.slice(0, MAX_SKIPPED_NAMES).map((name) => `\`${name}\``);
    if (skipped.length > names.length) names.push(`và ${skipped.length - names.length} file khác`);
    out.push(
      `_Chưa hiển thị diff của ${skipped.length} file vì vượt giới hạn kích thước: ${names.join(", ")}. ` +
        "Gọi lại với `path` để xem riêng từng file hoặc thư mục._",
    );
  }
  return out.join("\n\n");
}
