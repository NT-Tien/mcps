// Turns OpenProject HAL+JSON into compact Markdown that reads well as LLM context.

export const idFromHref = (href) => href?.match(/\/(\d+)(?:\?.*)?$/)?.[1] ?? null;

const linkTitle = (link) => link?.title || null;

const day = (iso) => (iso ? iso.slice(0, 10) : null);

const dateTime = (iso) => (iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : null);

/** ISO-8601 duration ("P1DT2H30M") -> "26h 30m". */
export function duration(iso) {
  const m = iso?.match(/^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+)M)?(?:[\d.]+S)?)?$/);
  if (!m) return iso || null;
  const hours = Number(m[1] || 0) * 24 + Number(m[2] || 0);
  const minutes = Number(m[3] || 0);
  if (!hours && !minutes) return null;
  return [hours ? `${hours}h` : null, minutes ? `${minutes}m` : null].filter(Boolean).join(" ");
}

/** Accepts 123, "123", "#123" or any OpenProject URL that points at a work package. */
export function parseWorkPackageId(input) {
  const text = String(input).trim();
  const match =
    text.match(/^#?(\d+)$/) || text.match(/(?:work_packages|wp)\/(?:details\/)?(\d+)/);
  if (!match) {
    throw new Error(`Không nhận ra ID ticket từ "${text}". Hãy truyền số ID, "#123" hoặc URL của ticket.`);
  }
  return match[1];
}

function field(label, value) {
  return value === null || value === undefined || value === "" ? null : `- **${label}:** ${value}`;
}

function workPackageRef(link) {
  const id = idFromHref(link?.href);
  return `#${id}${link?.title ? ` ${link.title}` : ""}`;
}

export function formatWorkPackageLine(wp) {
  const l = wp._links ?? {};
  const tags = [linkTitle(l.type), linkTitle(l.status), linkTitle(l.priority)].filter(Boolean).join(" · ");
  const meta = [
    linkTitle(l.project),
    linkTitle(l.assignee) ? `giao cho ${linkTitle(l.assignee)}` : "chưa giao",
    wp.dueDate ? `hạn ${wp.dueDate}` : null,
    `cập nhật ${day(wp.updatedAt)}`,
  ]
    .filter(Boolean)
    .join(", ");
  return `- **#${wp.id}** [${tags}] ${wp.subject}: ${meta}`;
}

function customFields(wp, schema) {
  const lines = [];
  const name = (key) => schema?.[key]?.name || key;

  for (const [key, value] of Object.entries(wp)) {
    if (!key.startsWith("customField")) continue;
    const text = value && typeof value === "object" ? value.raw : value;
    if (text === null || text === undefined || text === "") continue;
    lines.push(`- **${name(key)}:** ${String(text).trim()}`);
  }
  for (const [key, link] of Object.entries(wp._links ?? {})) {
    if (!key.startsWith("customField")) continue;
    const titles = [link].flat().map(linkTitle).filter(Boolean);
    if (titles.length) lines.push(`- **${name(key)}:** ${titles.join(", ")}`);
  }
  return lines;
}

function formatRelation(relation, workPackageId) {
  const from = relation._links?.from;
  const to = relation._links?.to;
  const outgoing = idFromHref(from?.href) === String(workPackageId);
  const kind = outgoing ? relation.type : relation.reverseType || relation.type;
  const note = relation.description ? ` (${relation.description})` : "";
  return `- ${kind} ${workPackageRef(outgoing ? to : from)}${note}`;
}

export function formatActivities(activities, userNames, { includeChanges }) {
  const blocks = [];
  for (const activity of activities) {
    const comment = activity.comment?.raw?.trim();
    const changes = includeChanges
      ? (activity.details ?? []).map((d) => d.raw?.trim()).filter(Boolean)
      : [];
    if (!comment && !changes.length) continue;

    const userHref = activity._links?.user?.href;
    const author = userNames.get(userHref) || `người dùng #${idFromHref(userHref) ?? "?"}`;
    const parts = [`### ${author}, ${dateTime(activity.createdAt)}`];
    if (changes.length) parts.push(changes.map((c) => `- ${c}`).join("\n"));
    if (comment) parts.push(comment);
    blocks.push(parts.join("\n\n"));
  }
  return blocks;
}

export function formatWorkPackage(wp, { url, schema, relations, attachments }) {
  const l = wp._links ?? {};
  const out = [`# #${wp.id} ${wp.subject}`, url];

  const progress =
    wp.percentageDone === null || wp.percentageDone === undefined ? null : `${wp.percentageDone}%`;
  out.push(
    [
      field("Loại", linkTitle(l.type)),
      field("Trạng thái", linkTitle(l.status)),
      field("Ưu tiên", linkTitle(l.priority)),
      field("Dự án", linkTitle(l.project)),
      field("Người tạo", linkTitle(l.author)),
      field("Người được giao", linkTitle(l.assignee) || "chưa giao"),
      field("Người chịu trách nhiệm", linkTitle(l.responsible)),
      field("Phiên bản", linkTitle(l.version)),
      field("Danh mục", linkTitle(l.category)),
      field("Bắt đầu", wp.startDate),
      field("Hạn", wp.dueDate || wp.date),
      field("Ước lượng", duration(wp.estimatedTime)),
      field("Đã dùng", duration(wp.spentTime)),
      field("Tiến độ", progress),
      field("Tạo lúc", dateTime(wp.createdAt)),
      field("Cập nhật lúc", dateTime(wp.updatedAt)),
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const custom = customFields(wp, schema);
  if (custom.length) out.push(`## Trường tuỳ chỉnh\n\n${custom.join("\n")}`);

  out.push(`## Mô tả\n\n${wp.description?.raw?.trim() || "_(không có mô tả)_"}`);

  const hierarchy = [];
  if (l.parent?.href) hierarchy.push(`- Cha: ${workPackageRef(l.parent)}`);
  for (const child of l.children ?? []) hierarchy.push(`- Con: ${workPackageRef(child)}`);
  if (hierarchy.length) out.push(`## Phân cấp\n\n${hierarchy.join("\n")}`);

  if (relations?.length) {
    out.push(`## Liên kết\n\n${relations.map((r) => formatRelation(r, wp.id)).join("\n")}`);
  }

  if (attachments?.length) {
    const lines = attachments.map((a) => {
      const size = a.fileSize ? `, ${Math.ceil(a.fileSize / 1024)} KB` : "";
      return `- [${a.id}] ${a.fileName} (${linkTitle(a._links?.author) || "?"}, ${day(a.createdAt)}${size})`;
    });
    out.push(
      "## Tệp đính kèm\n\n" +
        "Số trong ngoặc vuông là ID tệp, trùng với số trong `/api/v3/attachments/<ID>/content` ở phần mô tả. " +
        "Dùng get_attachment để xem nội dung.\n\n" +
        lines.join("\n"),
    );
  }

  return out.join("\n\n");
}
