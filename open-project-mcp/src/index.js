#!/usr/bin/env node
// Read-only MCP server for OpenProject.
//   node src/index.js          stdio: the MCP client spawns this process itself
//   node src/index.js --http   HTTP on 127.0.0.1: you start it, clients connect to the port
// In stdio mode stdout is reserved for the protocol, so all logging goes to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { OpenProjectClient, loadConfig } from "./client.js";
import {
  formatActivities,
  formatWorkPackage,
  formatWorkPackageLine,
  parseWorkPackageId,
} from "./format.js";

let client;
// Built on first use so a bad config surfaces as a readable tool error instead
// of the server dying before Claude Desktop can show anything.
function getClient() {
  client ??= new OpenProjectClient(loadConfig());
  return client;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const workPackageId = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe('Work package ID: a number, "#123", or the ticket URL copied from the browser.');

const TOOLS = [];
// Tools are collected here and registered on each McpServer that createServer()
// builds: stdio needs one server, stateless HTTP needs a fresh one per request.
function tool(name, config, handler) {
  TOOLS.push({ name, config, handler });
}

async function fetchUserNames(op, activities) {
  const hrefs = [...new Set(activities.map((a) => a._links?.user?.href).filter(Boolean))];
  const names = new Map();
  await Promise.all(
    hrefs.map(async (href) => {
      try {
        const user = await op.cachedHref(href);
        names.set(href, user.name || user.login);
      } catch {
        // Not allowed to see this user: the formatter falls back to the user ID.
      }
    }),
  );
  return names;
}

async function fetchActivityBlocks(op, id, { includeChanges, limit }) {
  const data = await op.api(`/work_packages/${id}/activities`);
  const activities = data._embedded?.elements ?? [];
  const names = await fetchUserNames(op, activities);
  const blocks = formatActivities(activities, names, { includeChanges });
  return { blocks: blocks.slice(-limit), total: blocks.length };
}

const optional = (promise) => promise.catch(() => null);

function createServer() {
  const server = new McpServer(
    { name: "openproject", version: "1.0.0" },
    {
      instructions:
        "Read-only access to OpenProject tickets (work packages). When the user mentions a ticket " +
        "number or pastes a ticket URL, call get_work_package to load its full context. Use " +
        "search_work_packages to find tickets by keyword, project, or assignee.",
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

tool(
  "get_work_package",
  {
    title: "Đọc ticket OpenProject",
    description:
      "Load one OpenProject work package (ticket) with everything needed to understand it: " +
      "type, status, priority, people, dates, custom fields, full description, parent/children, " +
      "relations, attachment names and the most recent comments.",
    inputSchema: {
      id: workPackageId,
      include_comments: z.boolean().default(true).describe("Include the comment thread."),
      comments_limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(30)
        .describe("Maximum number of most recent comments to include."),
    },
  },
  async ({ id, include_comments, comments_limit }, op) => {
    const wpId = parseWorkPackageId(id);
    const wp = await op.api(`/work_packages/${wpId}`);

    const schemaHref = wp._links?.schema?.href;
    const [schema, relations, attachments, comments] = await Promise.all([
      schemaHref ? optional(op.cachedHref(schemaHref)) : null,
      optional(op.api(`/work_packages/${wpId}/relations`)),
      optional(op.api(`/work_packages/${wpId}/attachments`)),
      include_comments
        ? optional(fetchActivityBlocks(op, wpId, { includeChanges: false, limit: comments_limit }))
        : null,
    ]);

    let text = formatWorkPackage(wp, {
      url: op.webUrl(wpId),
      schema,
      relations: relations?._embedded?.elements,
      attachments: attachments?._embedded?.elements,
    });

    if (comments?.blocks.length) {
      const shown = comments.blocks.length;
      const heading =
        shown < comments.total
          ? `## Bình luận (${shown} mới nhất trên tổng ${comments.total})`
          : `## Bình luận (${shown})`;
      text += `\n\n${heading}\n\n${comments.blocks.join("\n\n")}`;
    } else if (include_comments) {
      text += comments ? "\n\n## Bình luận\n\n_(chưa có bình luận)_" : "\n\n## Bình luận\n\n_(không tải được bình luận)_";
    }
    return text;
  },
);

tool(
  "get_work_package_activity",
  {
    title: "Lịch sử ticket OpenProject",
    description:
      "Full activity history of a work package in chronological order: comments plus field " +
      "changes (status transitions, reassignment, date changes...). Use it when the question is " +
      "about how a ticket evolved; get_work_package already returns the comments alone.",
    inputSchema: {
      id: workPackageId,
      include_changes: z.boolean().default(true).describe("Include field-change entries, not only comments."),
      limit: z.number().int().min(1).max(500).default(100).describe("Maximum number of most recent entries."),
    },
  },
  async ({ id, include_changes, limit }, op) => {
    const wpId = parseWorkPackageId(id);
    const { blocks, total } = await fetchActivityBlocks(op, wpId, { includeChanges: include_changes, limit });
    if (!blocks.length) return `Ticket #${wpId} chưa có hoạt động nào.`;
    const scope = blocks.length < total ? `${blocks.length} mục mới nhất trên tổng ${total}` : `${total} mục`;
    return `# Lịch sử ticket #${wpId} (${scope})\n\n${blocks.join("\n\n")}`;
  },
);

// Claude Desktop rejects tool results above roughly 1 MB, and base64 adds a third.
const MAX_IMAGE_BYTES = 700 * 1024;
const MAX_TEXT_CHARS = 50_000;
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|sql|x-ndjson))/;

tool(
  "get_attachment",
  {
    title: "Xem tệp đính kèm OpenProject",
    description:
      "Open one attachment of a work package: screenshots and other images are returned as an " +
      "image you can look at, text files (logs, JSON, CSV...) as text. Bug tickets often put the " +
      "actual result in screenshots, so view them when the description embeds images. The ID is " +
      "listed by get_work_package and appears in description image URLs as /api/v3/attachments/<ID>/content.",
    inputSchema: {
      id: z
        .union([z.number().int().positive(), z.string().min(1)])
        .describe("Attachment ID, or an /api/v3/attachments/<ID>/content URL."),
    },
  },
  async ({ id }, op) => {
    const match = String(id).trim().match(/^(\d+)$/) || String(id).match(/attachments\/(\d+)/);
    if (!match) throw new Error(`Không nhận ra ID tệp đính kèm từ "${id}".`);
    const attachmentId = match[1];

    const meta = await op.api(`/attachments/${attachmentId}`);
    const type = meta.contentType || "application/octet-stream";
    const sizeKb = Math.ceil((meta.fileSize ?? 0) / 1024);
    const label = `${meta.fileName} (${type}, ${sizeKb} KB)`;

    if (type.startsWith("image/")) {
      if (meta.fileSize > MAX_IMAGE_BYTES) {
        return `${label}: ảnh lớn hơn giới hạn ${MAX_IMAGE_BYTES / 1024} KB nên không gửi được qua MCP. Mở trực tiếp trên OpenProject để xem.`;
      }
      const data = await op.download(attachmentId);
      return [
        { type: "text", text: label },
        { type: "image", data: data.toString("base64"), mimeType: type },
      ];
    }

    if (TEXT_TYPES.test(type)) {
      const text = (await op.download(attachmentId)).toString("utf8");
      const cut = text.length > MAX_TEXT_CHARS ? `\n\n_(đã cắt, chỉ hiển thị ${MAX_TEXT_CHARS} trên ${text.length} ký tự)_` : "";
      return `${label}\n\n${text.slice(0, MAX_TEXT_CHARS)}${cut}`;
    }

    return `${label}: định dạng này không đọc được qua MCP. Mở trực tiếp trên OpenProject để xem.`;
  },
);

tool(
  "search_work_packages",
  {
    title: "Tìm ticket OpenProject",
    description:
      "Find OpenProject work packages (tickets), newest update first. Every filter is optional " +
      "and they combine with AND. Returns one line per ticket; call get_work_package for details.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Text to look for in subject, description and comments. A bare number matches the ticket ID."),
      project: z
        .string()
        .optional()
        .describe("Limit to one project: numeric ID or identifier (the slug in the project URL)."),
      status: z
        .enum(["open", "closed", "all"])
        .default("open")
        .describe("Which tickets to include by status."),
      assigned_to_me: z
        .boolean()
        .default(false)
        .describe("Only tickets assigned to the owner of the API token."),
      limit: z.number().int().min(1).max(100).default(20).describe("Tickets per page."),
      page: z.number().int().min(1).default(1).describe("Page number, starting at 1."),
    },
  },
  async ({ query, project, status, assigned_to_me, limit, page }, op) => {
    const statusOperator = { open: "o", closed: "c", all: "*" }[status];
    const filters = [{ status: { operator: statusOperator, values: [] } }];
    const text = query?.trim();
    if (text) {
      const name = /^#?\d+$/.test(text) ? "subjectOrId" : "search";
      filters.push({ [name]: { operator: "**", values: [text.replace(/^#/, "")] } });
    }
    if (assigned_to_me) filters.push({ assignee: { operator: "=", values: ["me"] } });

    const path = project?.trim()
      ? `/projects/${encodeURIComponent(project.trim())}/work_packages`
      : "/work_packages";
    const data = await op.api(path, {
      filters,
      pageSize: limit,
      offset: page,
      sortBy: [["updatedAt", "desc"]],
    });

    const items = data._embedded?.elements ?? [];
    if (!items.length) return "Không tìm thấy ticket nào khớp điều kiện.";

    const first = (page - 1) * limit + 1;
    const last = first + items.length - 1;
    const more = last < data.total ? ` Gọi lại với page=${page + 1} để xem tiếp.` : "";
    return (
      `Tìm thấy ${data.total} ticket, đang hiển thị ${first}-${last}.${more}\n\n` +
      items.map(formatWorkPackageLine).join("\n")
    );
  },
);

tool(
  "list_projects",
  {
    title: "Danh sách dự án OpenProject",
    description:
      "List the active OpenProject projects the API token can see, with the ID and identifier " +
      "that search_work_packages accepts in its `project` argument.",
    inputSchema: {
      query: z.string().optional().describe("Only projects whose name or identifier contains this text."),
      limit: z.number().int().min(1).max(200).default(100).describe("Maximum number of projects."),
    },
  },
  async ({ query, limit }, op) => {
    const filters = [{ active: { operator: "=", values: ["t"] } }];
    if (query?.trim()) {
      filters.push({ name_and_identifier: { operator: "~", values: [query.trim()] } });
    }
    const data = await op.api("/projects", { filters, pageSize: limit, sortBy: [["name", "asc"]] });

    const items = data._embedded?.elements ?? [];
    if (!items.length) return "Không có dự án nào khớp.";

    const lines = items.map((p) => {
      const parent = p._links?.parent?.title ? `, thuộc ${p._links.parent.title}` : "";
      return `- **${p.name}**: id ${p.id}, identifier \`${p.identifier}\`${parent}`;
    });
    const scope = items.length < data.total ? `${items.length} trên tổng ${data.total}` : `${data.total}`;
    return `Dự án (${scope}):\n\n${lines.join("\n")}`;
  },
);

async function runStdio() {
  await createServer().connect(new StdioServerTransport());
  console.error("OpenProject MCP server đang chạy (stdio).");
}

async function runHttp(port) {
  const { createMcpExpressApp } = await import("@modelcontextprotocol/sdk/server/express.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

  // Fail at startup, where the person running it sees the message, not on the first tool call.
  try {
    getClient();
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
      console.error(`OpenProject MCP server đang chạy tại http://localhost:${port}/mcp (Ctrl+C để dừng)`);
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
  const port = Number(portFlag !== -1 ? args[portFlag + 1] : process.env.OPENPROJECT_MCP_PORT || 4100);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("Cổng không hợp lệ. Ví dụ: node src/index.js --http --port 4100");
    process.exit(1);
  }
  await runHttp(port);
} else {
  await runStdio();
}
