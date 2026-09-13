/**
 * The CLI's one-shot loopback HTTP server: binds `127.0.0.1:<port>` FIRST
 * (so a busy port fails loud and fast, before the browser even opens),
 * waits for exactly one `/callback` request carrying `state` + `code`, and
 * always closes the server afterwards -- on success, on a state mismatch,
 * on an upstream error, or on timeout.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** Distinguishes the two CLI-only failure shapes from the shared `YotoErrorCode` union in packages/core. */
export type LoopbackErrorCode = "PORT_IN_USE" | "AUTH_TIMEOUT" | "CALLBACK_ERROR";

export class LoopbackError extends Error {
  readonly code: LoopbackErrorCode;
  readonly hint: string | undefined;

  constructor(message: string, code: LoopbackErrorCode, hint?: string) {
    super(message);
    this.name = "LoopbackError";
    this.code = code;
    this.hint = hint;
  }
}

export interface LoopbackOptions {
  port: number;
  expectedState: string;
  /** How long to wait for the callback before giving up. Default 300_000ms (300s). */
  timeoutMs?: number;
  /** Injected timer functions, for deterministic tests with fake timers. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export interface LoopbackResult {
  code: string;
}

const SUCCESS_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Signed in to Yoto</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:3rem;max-width:32rem;margin:0 auto">' +
  "<h1>You're signed in — you can close this tab.</h1>" +
  "<p>Head back to your AI client -- mcp-yoto is ready.</p></body></html>";

function failureHtml(message: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head>' +
    '<body style="font-family:system-ui,sans-serif;padding:3rem;max-width:32rem;margin:0 auto">' +
    "<h1>Sign-in failed</h1>" +
    `<p>${escapeHtml(message)}</p></body></html>`
  );
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

/**
 * Waits for the single OAuth callback this sign-in attempt expects.
 *
 * Binds the port before returning, so a caller can `await` this and only
 * then open the browser / print the sign-in URL, confident the redirect has
 * somewhere to land. Every exit path (success, state mismatch, upstream
 * `error=`, bind failure, timeout) closes the server exactly once.
 */
export function awaitLoopbackCallback(options: LoopbackOptions): Promise<LoopbackResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;

  return new Promise<LoopbackResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server: Server = createServer(handleRequest);

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeoutImpl(timer);
      server.close();
      action();
    }

    function handleRequest(req: IncomingMessage, res: ServerResponse): void {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${options.port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const upstreamError = url.searchParams.get("error");
      if (upstreamError) {
        sendHtml(res, 200, failureHtml(`Yoto returned an error: ${upstreamError}`));
        finish(() =>
          reject(
            new LoopbackError(
              `Yoto returned an error during sign-in: ${upstreamError}`,
              "CALLBACK_ERROR",
            ),
          ),
        );
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || state !== options.expectedState) {
        sendHtml(res, 400, failureHtml("This sign-in link is stale or was tampered with."));
        finish(() =>
          reject(
            new LoopbackError(
              "Sign-in callback state did not match -- stale or invalid attempt.",
              "CALLBACK_ERROR",
              "Run yoto_sign_in again.",
            ),
          ),
        );
        return;
      }

      sendHtml(res, 200, SUCCESS_HTML);
      finish(() => resolve({ code }));
    }

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        finish(() =>
          reject(
            new LoopbackError(
              `Port ${options.port} is already in use.`,
              "PORT_IN_USE",
              "Set YOTO_REDIRECT_PORT to a free port that's also registered at Yoto, or close whatever's using it.",
            ),
          ),
        );
        return;
      }
      finish(() => reject(new LoopbackError(err.message, "CALLBACK_ERROR")));
    });

    server.listen(options.port, "127.0.0.1", () => {
      timer = setTimeoutImpl(() => {
        finish(() =>
          reject(
            new LoopbackError(
              "Timed out waiting for the Yoto sign-in callback.",
              "AUTH_TIMEOUT",
              "Run yoto_sign_in again.",
            ),
          ),
        );
      }, timeoutMs);
    });
  });
}
