/**
 * Runtime-agnostic Yoto API client. Phase 0 stub — the real implementation
 * (429 Retry-After handling, full-jitter 5xx retries, paginate(), zod-parsed
 * responses per endpoint) lands in Phase 1. Deliberately fetch + WebCrypto
 * only, no node:* imports, so the same client runs unchanged in the
 * Cloudflare Worker and the Node CLI.
 */
export interface YotoClientOptions {
  /** Returns a valid Yoto access token, refreshing it first if needed. */
  getToken: () => Promise<string>;
  /** Injected so tests can supply a mock; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Defaults to https://api.yotoplay.com */
  baseUrl?: string;
}

export class YotoClient {
  private readonly getToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: YotoClientOptions) {
    this.getToken = options.getToken;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? "https://api.yotoplay.com";
  }

  /** Used by the Phase 0 smoke test; also handy for `yoto_status` later. */
  describe(): { baseUrl: string } {
    return { baseUrl: this.baseUrl };
  }

  /**
   * Placeholder for the real request pipeline that lands in Phase 1. Proves
   * the constructor-injected token getter and fetch implementation are both
   * wired through, without yet knowing about any real Yoto endpoint.
   */
  async ping(): Promise<{ ok: boolean }> {
    await this.getToken();
    const response = await this.fetchImpl(this.baseUrl);
    return { ok: response.ok };
  }
}
