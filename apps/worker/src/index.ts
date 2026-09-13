/**
 * mcp-yoto Cloudflare Worker. Phase 0 stub -- the real OAuthProvider wiring
 * (upstream.ts, refresh.ts) lands in Phase 3, and the /mcp streamable-HTTP
 * handler in Phase 4. This stub only proves the Worker builds and deploys,
 * answering 200 at /healthz per the plan's repo layout.
 */
export interface Env {
  OAUTH_KV: KVNamespace;
  ISSUER: string;
  YOTO_CLIENT_ID?: string;
  YOTO_CLIENT_SECRET?: string;
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }
    return new Response("mcp-yoto worker scaffold -- see /healthz", { status: 200 });
  },
} satisfies ExportedHandler<Env>;
