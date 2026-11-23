import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Settings come from config.json (next to package.json, or the path in
 * OPENPROJECT_CONFIG); environment variables win over the file.
 */
export function loadConfig() {
  const configPath = process.env.OPENPROJECT_CONFIG || resolve(PROJECT_ROOT, "config.json");
  let file = {};
  try {
    file = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Không đọc được ${configPath}: ${err.message}`);
    }
  }

  const baseUrl = (process.env.OPENPROJECT_BASE_URL || file.open_project_base_url || "").trim();
  const token = (process.env.OPENPROJECT_API_TOKEN || file.open_project_api_token || "").trim();

  const missing = [];
  if (!baseUrl) missing.push("open_project_base_url (hoặc biến môi trường OPENPROJECT_BASE_URL)");
  if (!token) missing.push("open_project_api_token (hoặc biến môi trường OPENPROJECT_API_TOKEN)");
  if (missing.length) {
    throw new Error(`Thiếu cấu hình trong ${configPath}: ${missing.join(", ")}`);
  }

  return {
    // Accept "https://host", "https://host/" and "https://host/api/v3".
    baseUrl: baseUrl.replace(/\/+$/, "").replace(/\/api\/v3$/, ""),
    token,
  };
}

export class OpenProjectError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class OpenProjectClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = baseUrl;
    this.authHeader = "Basic " + Buffer.from(`apikey:${token}`).toString("base64");
    this.cache = new Map();
  }

  /** GET a path below /api/v3, e.g. api("/work_packages/12"). */
  api(path, params) {
    return this.#request(new URL(`${this.baseUrl}/api/v3${path}`), params);
  }

  /** GET an href taken from a HAL `_links` entry (already includes any sub-path). */
  href(href) {
    return this.#request(new URL(href, this.baseUrl));
  }

  /** Like href(), but memoised: for users and schemas that rarely change. */
  cachedHref(href) {
    if (!this.cache.has(href)) {
      const pending = this.href(href).catch((err) => {
        this.cache.delete(href);
        throw err;
      });
      this.cache.set(href, pending);
    }
    return this.cache.get(href);
  }

  webUrl(workPackageId) {
    return `${this.baseUrl}/work_packages/${workPackageId}`;
  }

  /** Download the binary content of an attachment. */
  async download(attachmentId) {
    const url = new URL(`${this.baseUrl}/api/v3/attachments/${attachmentId}/content`);
    // The content endpoint may redirect to external storage; fetch drops the
    // Authorization header on cross-origin redirects, so the token stays put.
    const res = await this.#fetch(url, "*/*");
    if (!res.ok) {
      throw new OpenProjectError(res.status, `Không tải được tệp đính kèm #${attachmentId} (HTTP ${res.status}).`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async #fetch(url, accept) {
    try {
      return await fetch(url, {
        headers: { Authorization: this.authHeader, Accept: accept },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err.name === "TimeoutError" ? "quá thời gian chờ" : err.cause?.message || err.message;
      throw new OpenProjectError(0, `Không kết nối được tới ${url.origin}: ${reason}`);
    }
  }

  async #request(url, params = {}) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }

    const res = await this.#fetch(url, "application/hal+json");
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body (login page, proxy error...) is handled below.
    }

    if (!res.ok) {
      const detail = body?.message || text.slice(0, 200) || res.statusText;
      const hint =
        res.status === 401
          ? " (API token sai hoặc đã hết hạn)"
          : res.status === 403
            ? " (tài khoản không có quyền xem)"
            : res.status === 404
              ? " (không tồn tại, hoặc tài khoản không có quyền xem)"
              : "";
      throw new OpenProjectError(res.status, `OpenProject trả về ${res.status}${hint}: ${detail}`);
    }
    if (body === null) {
      throw new OpenProjectError(
        res.status,
        `Phản hồi từ ${url.origin} không phải JSON: kiểm tra lại open_project_base_url.`,
      );
    }
    return body;
  }
}
