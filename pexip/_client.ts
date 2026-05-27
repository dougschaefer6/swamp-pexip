import { z } from "npm:zod@4.3.6";

/**
 * Shared Pexip Infinity Management API client and schemas.
 *
 * The Pexip management node exposes a REST API at /api/admin/ for configuration
 * and /api/admin/status/ for runtime status. All endpoints return JSON and use
 * HTTP Basic authentication with the admin credentials.
 *
 * Credentials are passed via globalArguments, typically resolved from vault:
 *   host:     management node FQDN or IP
 *   username: admin username (default: "admin")
 *   password: ${{ vault.get(<vault>, pexip-admin-password) }}
 */

export const PexipGlobalArgsSchema = z.object({
  host: z.string().describe(
    "Pexip management node FQDN or IP address (e.g., 10.100.0.10)",
  ),
  username: z
    .string()
    .default("admin")
    .describe("Admin username for the management node"),
  password: z.string().meta({ sensitive: true }).describe(
    "Admin password. Use: ${{ vault.get(<vault>, pexip-admin-password) }}",
  ),
  verifySsl: z
    .boolean()
    .default(true)
    .describe("Verify TLS certificate (set false for self-signed certs)"),
});

export type PexipGlobalArgs = z.infer<typeof PexipGlobalArgsSchema>;

/**
 * Make a request to the Pexip Infinity management API.
 *
 * API docs: https://docs.pexip.com/admin/admin_api.htm
 * Base path: /api/admin/configuration/v1/ (config) or /api/admin/status/v1/ (status)
 */
export async function pexipApi(
  path: string,
  globalArgs: PexipGlobalArgs,
  options?: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
  },
): Promise<unknown> {
  const protocol = "https";
  const url = new URL(path, `${protocol}://${globalArgs.host}`);

  if (options?.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }

  const credentials = btoa(`${globalArgs.username}:${globalArgs.password}`);
  const headers: Record<string, string> = {
    Authorization: `Basic ${credentials}`,
    Accept: "application/json",
  };

  const fetchOptions: RequestInit = {
    method: options?.method || "GET",
    headers,
  };

  if (options?.body) {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(options.body);
  }

  const resp = await fetch(url.toString(), fetchOptions);

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `Pexip API ${resp.status} ${resp.statusText}: ${body}`,
    );
  }

  const contentType = resp.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return resp.json();
  }

  // Some DELETE operations return empty body
  return null;
}

/**
 * Paginated list helper — Pexip API uses limit/offset pagination.
 * Returns all objects across pages.
 */
export async function pexipListAll(
  path: string,
  globalArgs: PexipGlobalArgs,
  params?: Record<string, string>,
): Promise<Array<Record<string, unknown>>> {
  const allObjects: Array<Record<string, unknown>> = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const result = (await pexipApi(path, globalArgs, {
      params: { ...params, limit: String(limit), offset: String(offset) },
    })) as {
      meta?: { total_count?: number };
      objects?: Array<Record<string, unknown>>;
    };

    const objects = result?.objects || [];
    allObjects.push(...objects);

    const totalCount = result?.meta?.total_count ?? objects.length;
    offset += limit;

    if (offset >= totalCount || objects.length === 0) break;
  }

  return allObjects;
}

// --- Configuration API paths ---
export const CONFIG_BASE = "/api/admin/configuration/v1";
export const STATUS_BASE = "/api/admin/status/v1";
export const HISTORY_BASE = "/api/admin/history/v1";

// --- Shared helpers ---

export function sanitizeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extract the resource ID from a Pexip API resource_uri.
 * e.g., "/api/admin/configuration/v1/conference/42/" → "42"
 */
export function extractId(resourceUri: string): string {
  const parts = resourceUri.replace(/\/$/, "").split("/");
  return parts[parts.length - 1];
}
