import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, REDACTED, scrub } from "../src/log.js";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

/** A JWT-shaped string, deliberately fake. */
const FAKE_JWT =
  "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhdXRoMHwxMjMiLCJhdWQiOiJodHRwczovL2FwaS55b3RvcGxheS5jb20ifQ.c2lnbmF0dXJlLWdvZXMtaGVyZQ";
/** The provider's own opaque token shape: userId:grantId:secret. */
const FAKE_OPAQUE = "authZeroUser:grantIdentifier:c3VwZXJzZWNyZXRyYW5kb21zdHJpbmc";

function captureConsole() {
  const lines: string[] = [];
  const sink = (value: unknown) => {
    lines.push(String(value));
  };
  vi.spyOn(console, "log").mockImplementation(sink);
  vi.spyOn(console, "warn").mockImplementation(sink);
  vi.spyOn(console, "error").mockImplementation(sink);
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scrub", () => {
  it("redacts JWTs", () => {
    expect(scrub(`Bearer ${FAKE_JWT}`)).not.toContain("eyJ");
    expect(scrub(`Bearer ${FAKE_JWT}`)).toContain(REDACTED);
  });

  it("redacts the provider's opaque tokens", () => {
    expect(scrub(FAKE_OPAQUE)).toBe(REDACTED);
  });

  it("redacts any long unbroken secret-shaped run", () => {
    expect(scrub("state=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")).toContain(REDACTED);
  });

  it("leaves ordinary short text alone", () => {
    expect(scrub("invalid_grant")).toBe("invalid_grant");
    expect(scrub("callback.grant_issued")).toBe("callback.grant_issued");
  });
});

describe("logger", () => {
  it("redacts values whose FIELD NAME suggests a credential", () => {
    const lines = captureConsole();
    createLogger({ LOG_LEVEL: "debug" }).info("test", {
      access_token: "short",
      code_verifier: "short",
      client_secret: "short",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("short");
  });

  it("redacts credential-shaped VALUES even under an innocent field name", () => {
    const lines = captureConsole();
    createLogger({ LOG_LEVEL: "debug" }).info("test", { detail: `authorization: ${FAKE_JWT}` });
    expect(lines[0]).not.toContain("eyJ");
  });

  it("cannot be handed an object that would smuggle props in wholesale", () => {
    // Compile-time guarantee, asserted here so the intent survives a refactor:
    // LogField is scalar-only, so `log.info("x", { props })` does not typecheck.
    const lines = captureConsole();
    const logger = createLogger({ LOG_LEVEL: "debug" });
    // @ts-expect-error objects are not a LogField
    logger.info("test", { props: { yotoAccessToken: "fake-access-token" } });
    // Even if someone forces it past TypeScript, JSON.stringify of the object
    // still goes through the field-name gate.
    expect(lines[0]).not.toContain("fake-access-token");
  });

  it("honours LOG_LEVEL", () => {
    const lines = captureConsole();
    createLogger({ LOG_LEVEL: "warn" }).info("quiet");
    expect(lines).toHaveLength(0);
    createLogger({ LOG_LEVEL: "warn" }).warn("loud");
    expect(lines).toHaveLength(1);
  });
});

describe("source rules", () => {
  const files = readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(SRC_DIR, name), "utf8") }));

  it("routes every log through log.ts", () => {
    // The whole redaction guarantee rests on this: one chokepoint. A bare
    // console.* call anywhere else could be handed a token by a later edit.
    const offenders = files
      .filter(
        (file) =>
          file.name !== "log.ts" && /\bconsole\.(log|info|warn|error|debug)\(/.test(file.text),
      )
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it("never interpolates a props field into a template literal", () => {
    const offenders = files
      .filter((file) => /\$\{[^}]*yoto(Access|Refresh)Token[^}]*\}/.test(file.text))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });
});
