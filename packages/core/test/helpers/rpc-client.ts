/**
 * A deliberately minimal JSON-RPC client for the contract test: there is no
 * `@modelcontextprotocol/client` package installed in this monorepo (only
 * core/hono/node/server), so rather than add an unverified new dependency
 * for one test file, this speaks just enough raw JSON-RPC over the SDK's
 * own `InMemoryTransport.createLinkedPair()` to drive `initialize`,
 * `tools/list`, `tools/call`, `resources/list` and `prompts/list`.
 */
import { InMemoryTransport, type McpServer } from "@modelcontextprotocol/server";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface MinimalRpcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  close(): Promise<void>;
}

/**
 * Connects a fresh in-memory client/server transport pair to `server` and
 * completes the MCP `initialize` handshake, so subsequent calls behave as a
 * real client would see them.
 */
export async function connectMinimalClient(server: McpServer): Promise<MinimalRpcClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();

  clientTransport.onmessage = (message: unknown) => {
    const response = message as JsonRpcResponse;
    if (
      response &&
      typeof response === "object" &&
      typeof response.id === "number" &&
      pending.has(response.id)
    ) {
      const waiter = pending.get(response.id);
      pending.delete(response.id);
      if (!waiter) return;
      if (response.error) waiter.reject(new Error(response.error.message));
      else waiter.resolve(response.result);
    }
  };

  await clientTransport.start();
  await server.connect(serverTransport);

  async function request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
    await clientTransport.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  async function notify(method: string, params: unknown = {}): Promise<void> {
    await clientTransport.send({ jsonrpc: "2.0", method, params });
  }

  await request("initialize", {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "mcp-yoto-contract-test", version: "0.0.0" },
  });
  await notify("notifications/initialized");

  return {
    request,
    close: async () => {
      await clientTransport.close();
    },
  };
}
