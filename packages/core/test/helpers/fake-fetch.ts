/** A small, queue-based `fetch` fake shared across the client/media tests. */
export interface FakeResponseSpec {
  status: number;
  headers?: Record<string, string>;
  jsonBody?: unknown;
  textBody?: string;
}

export interface FakeFetchCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
}

export function makeFakeFetch(responses: FakeResponseSpec[]): {
  fetch: typeof fetch;
  calls: FakeFetchCall[];
} {
  const queue = [...responses];
  const calls: FakeFetchCall[] = [];

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [key, value] of Object.entries(init.headers as Record<string, string>))
        headers[key] = value;
    }
    calls.push({ url, method: init?.method, headers });
    const spec = queue.shift();
    if (!spec) {
      throw new Error(`makeFakeFetch: no more responses queued (call #${calls.length} to ${url})`);
    }
    const body =
      spec.jsonBody !== undefined ? JSON.stringify(spec.jsonBody) : (spec.textBody ?? "");
    return new Response(body, { status: spec.status, headers: spec.headers });
  }) as typeof fetch;

  return { fetch: fetchFn, calls };
}
