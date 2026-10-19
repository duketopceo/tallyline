/**
 * Thin REST client over the tallyline API. The MCP server never touches
 * Postgres — every tool call is an authenticated HTTP request against
 * `TALLYLINE_API_URL` so the API's auth, scope, and state-machine rules are
 * the single source of truth.
 */

export interface TallylineClientConfig {
  apiUrl: string;
  token: string;
  workspace: string;
  /** Injectable for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** An error surfaced by the API's {error:{code,message}} envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** parsed error body, e.g. the fresh `diff` on a 409 STALE_DIFF */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Whoami {
  type: "agent" | "human";
  id: string;
  name: string;
  scopes: string[];
  workspaceId: string;
  workspaceSlug: string | null;
}

type Query = Record<string, string | number | boolean | undefined>;

export class TallylineClient {
  private readonly baseUrl: string;
  private readonly wsBase: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private cachedWhoami: Promise<Whoami> | null = null;

  constructor(config: TallylineClientConfig) {
    this.baseUrl = config.apiUrl.replace(/\/+$/, "");
    this.wsBase = `${this.baseUrl}/v1/workspaces/${encodeURIComponent(config.workspace)}`;
    this.token = config.token;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** Identity of the presented credential (agent key or PAT). */
  whoami(): Promise<Whoami> {
    // identity is stable for the lifetime of the token — cache it
    this.cachedWhoami ??= this.request<Whoami>(
      "GET",
      `${this.baseUrl}/v1/whoami`,
    );
    return this.cachedWhoami;
  }

  apiGet<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", this.ws(path), query);
  }

  apiPost<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", this.ws(path), undefined, body);
  }

  apiPatch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", this.ws(path), undefined, body);
  }

  private ws(path: string): string {
    return `${this.wsBase}${path}`;
  }

  private async request<T>(
    method: string,
    url: string,
    query?: Query,
    body?: unknown,
  ): Promise<T> {
    let target = url;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) target += `?${qs}`;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(target, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new ApiError(
        0,
        "UNREACHABLE",
        `cannot reach tallyline API at ${this.baseUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const text = await res.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!res.ok) {
      const apiErr = (data as { error?: { code?: string; message?: string } })
        ?.error;
      throw new ApiError(
        res.status,
        apiErr?.code ?? "HTTP_ERROR",
        apiErr?.message ?? `HTTP ${res.status} from tallyline API`,
        data,
      );
    }
    return data as T;
  }
}
