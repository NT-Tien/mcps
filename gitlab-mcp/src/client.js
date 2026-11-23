import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PAGE_SIZE = 100; // GitLab caps per_page here.

/**
 * Settings come from config.json (next to package.json, or the path in
 * GITLAB_CONFIG); environment variables win over the file.
 */
export function loadConfig() {
  const configPath = process.env.GITLAB_CONFIG || resolve(PROJECT_ROOT, "config.json");
  let file = {};
  try {
    file = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Không đọc được ${configPath}: ${err.message}`);
    }
  }

  const baseUrl = (process.env.GITLAB_BASE_URL || file.gitlab_base_url || "https://gitlab.com").trim();
  // The token is optional: without it only public projects are readable.
  const token = (process.env.GITLAB_API_TOKEN || file.gitlab_api_token || "").trim();

  let valid = /^https?:\/\//i.test(baseUrl);
  try {
    new URL(baseUrl);
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new Error(`gitlab_base_url trong ${configPath} không hợp lệ: "${baseUrl}". Ví dụ: https://gitlab.com`);
  }

  return {
    // Accept "https://host", "https://host/" and "https://host/api/v4".
    baseUrl: baseUrl.replace(/\/+$/, "").replace(/\/api\/v4$/, ""),
    token,
  };
}

export class GitLabError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class GitLabClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.cache = new Map();
  }

  /** GET a path below /api/v4 and return the parsed JSON, e.g. api("/projects/12"). */
  async api(path, params) {
    return (await this.#json(path, params)).body;
  }

  /** Like api(), but memoised: for things that do not change, such as the token's owner. */
  cached(path) {
    if (!this.cache.has(path)) {
      const pending = this.api(path).catch((err) => {
        this.cache.delete(path);
        throw err;
      });
      this.cache.set(path, pending);
    }
    return this.cache.get(path);
  }

  /**
   * One page of a list endpoint, plus what the pagination headers say about the
   * rest. `total` is null where GitLab does not count (commits, huge lists).
   */
  async page(path, params) {
    const { body, headers } = await this.#json(path, params);
    if (!Array.isArray(body)) {
      throw new GitLabError(200, `GitLab trả về dữ liệu không phải danh sách cho ${path}.`);
    }
    const number = (name) => Number(headers.get(name)) || null;
    return { items: body, total: number("x-total"), nextPage: number("x-next-page") };
  }

  /** Every item of a list endpoint, following the pages until `max` items are collected. */
  async all(path, params = {}, max = 1000) {
    const items = [];
    let page = 1;
    while (page && items.length < max) {
      const res = await this.page(path, { ...params, per_page: MAX_PAGE_SIZE, page });
      items.push(...res.items);
      page = res.nextPage;
    }
    return { items: items.slice(0, max), truncated: Boolean(page) || items.length > max };
  }

  /** GET a path below /api/v4 and return the response body as bytes (raw file content). */
  async raw(path, params) {
    const res = await this.#fetch(this.#url(path, params), "*/*");
    if (!res.ok) throw this.#error(res, await res.text());
    return Buffer.from(await res.arrayBuffer());
  }

  #url(path, params = {}) {
    const url = new URL(`${this.baseUrl}/api/v4${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  async #fetch(url, accept) {
    const headers = { Accept: accept };
    // Authorization rather than PRIVATE-TOKEN: fetch drops it on cross-origin
    // redirects, so the token never follows a redirect to external storage.
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      return await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      const reason = err.name === "TimeoutError" ? "quá thời gian chờ" : err.cause?.message || err.message;
      throw new GitLabError(0, `Không kết nối được tới ${url.origin}: ${reason}`);
    }
  }

  #error(res, text) {
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Non-JSON body (login page, proxy error...): fall back to the raw text.
    }
    const message = body?.message ?? body?.error_description ?? body?.error;
    const detail =
      (typeof message === "string" ? message : message && JSON.stringify(message)) ||
      text.slice(0, 200) ||
      res.statusText;

    const hints = {
      401: "token sai, đã hết hạn hoặc thiếu scope read_api",
      403: "token không đủ quyền: cần scope read_api và quyền xem project",
      404: "không tồn tại, hoặc token không có quyền xem",
      429: "vượt giới hạn số request, thử lại sau ít phút",
    };
    // Without a token GitLab hides private projects behind "404 Project Not Found"
    // and refuses merge request comments with 401, even on public projects.
    const needsToken = !this.token && (res.status === 401 || res.status === 403 || /project not found/i.test(detail));
    const hint = needsToken
      ? "chưa cấu hình gitlab_api_token: không có token thì chỉ đọc được project công khai, và không đọc được bình luận của merge request"
      : hints[res.status];
    return new GitLabError(res.status, `GitLab trả về ${res.status}${hint ? ` (${hint})` : ""}: ${detail}`);
  }

  async #json(path, params) {
    const url = this.#url(path, params);
    const res = await this.#fetch(url, "application/json");
    const text = await res.text();
    if (!res.ok) throw this.#error(res, text);

    try {
      return { body: JSON.parse(text), headers: res.headers };
    } catch {
      throw new GitLabError(
        res.status,
        `Phản hồi từ ${url.origin} không phải JSON: kiểm tra lại gitlab_base_url.`,
      );
    }
  }
}
