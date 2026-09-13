/**
 * Thin wrapper around Yoto's `POST /oauth/token` endpoint, shared by both
 * legs that call it: the authorization-code exchange (adapter.ts, once per
 * sign-in) and the refresh-token grant (session.ts, on every access-token
 * renewal). Kept deliberately dumb -- it does not interpret the response,
 * just forwards it -- so the two callers can apply their own (different)
 * error handling.
 */

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface TokenErrorBody {
  error?: string;
  error_description?: string;
}

export type TokenResult =
  | { ok: true; data: TokenResponse }
  | { ok: false; status: number; error?: TokenErrorBody };

export async function postTokenRequest(
  fetchImpl: typeof fetch,
  tokenUrl: string,
  params: Record<string, string>,
): Promise<TokenResult> {
  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });

  if (response.ok) {
    return { ok: true, data: (await response.json()) as TokenResponse };
  }

  let error: TokenErrorBody | undefined;
  try {
    error = (await response.json()) as TokenErrorBody;
  } catch {
    // Non-JSON error body -- leave `error` undefined, callers fall back to the status code alone.
  }
  return { ok: false, status: response.status, error };
}
