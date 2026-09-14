import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  type Env,
  getConfig,
  RESOURCE_SCOPES,
  YOTO_SCOPE_STRING,
  YOTO_SCOPES,
} from "../src/config.js";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(): { name: string; text: string }[] {
  return readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(SRC_DIR, name), "utf8") }));
}

function envFixture(overrides: Partial<Env> = {}): Env {
  return {
    ISSUER: "https://mcp-yoto.example.workers.dev",
    YOTO_CLIENT_ID: "test-client-id",
    STATE_SECRET: "0123456789abcdef0123456789abcdef",
    ...overrides,
  } as Env;
}

describe("getConfig", () => {
  it("derives the redirect URI and resource from ISSUER", () => {
    const config = getConfig(envFixture());
    expect(config.issuer).toBe("https://mcp-yoto.example.workers.dev");
    expect(config.redirectUri).toBe("https://mcp-yoto.example.workers.dev/callback");
    expect(config.resource).toBe("https://mcp-yoto.example.workers.dev/mcp");
  });

  it("strips a trailing slash from ISSUER so the redirect URI never doubles up", () => {
    const config = getConfig(envFixture({ ISSUER: "https://mcp-yoto.example.workers.dev/" }));
    expect(config.redirectUri).toBe("https://mcp-yoto.example.workers.dev/callback");
  });

  it("defaults the Yoto endpoints", () => {
    const config = getConfig(envFixture());
    expect(config.yotoAuthorizeUrl).toBe("https://login.yotoplay.com/authorize");
    expect(config.yotoTokenUrl).toBe("https://login.yotoplay.com/oauth/token");
    expect(config.yotoAudience).toBe("https://api.yotoplay.com");
    expect(config.logLevel).toBe("info");
  });

  it("treats a missing client secret as a public client rather than an error", () => {
    expect(getConfig(envFixture()).yotoClientSecret).toBeUndefined();
  });

  it("names the missing variable when STATE_SECRET is absent", () => {
    const env = envFixture();
    delete (env as Partial<Env>).STATE_SECRET;
    expect(() => getConfig(env)).toThrow(ConfigError);
    expect(() => getConfig(env)).toThrow(/STATE_SECRET/);
  });

  it("rejects a STATE_SECRET that is too short to be worth deriving a key from", () => {
    expect(() => getConfig(envFixture({ STATE_SECRET: "too-short" }))).toThrow(/STATE_SECRET/);
  });

  it("names YOTO_CLIENT_ID and ISSUER when both are wrong", () => {
    const env = envFixture({ ISSUER: "not-a-url", YOTO_CLIENT_ID: "" });
    let message = "";
    try {
      getConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("ISSUER");
    expect(message).toContain("YOTO_CLIENT_ID");
  });

  it("never puts a configuration VALUE in the error message", () => {
    const env = envFixture({ STATE_SECRET: "short-but-secret" });
    let message = "";
    try {
      getConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("short-but-secret");
  });

  it("caches per env object", () => {
    const env = envFixture();
    expect(getConfig(env)).toBe(getConfig(env));
  });
});

describe("scopes", () => {
  it("is exactly the agreed set", () => {
    expect([...YOTO_SCOPES]).toEqual([
      "profile",
      "offline_access",
      "user:content:view",
      "user:content:manage",
      "user:icons:manage",
      "family:library:view",
      "family:devices:view",
      "family:device-status:view",
    ]);
  });

  it("never requests device control or device management", () => {
    // Yoto's Verified listing excludes device-control scopes. This is the
    // guard: if anyone adds one, this fails before it can ship.
    expect(YOTO_SCOPE_STRING).not.toContain("devices:control");
    expect(YOTO_SCOPE_STRING).not.toContain("devices:manage");
  });

  it("has no device-control scope anywhere in the Worker source", () => {
    // Comments are stripped first: config.ts names both forbidden scopes in
    // prose precisely to explain why they are absent from the code.
    const stripComments = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const offenders = sourceFiles()
      .filter((file) => /devices:(control|manage)/.test(stripComments(file.text)))
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it("omits offline_access from the protected-resource scopes", () => {
    // RFC 9728 metadata describes resource permissions; refresh-token issuance
    // is an authorization-server capability, not one of them.
    expect(RESOURCE_SCOPES).not.toContain("offline_access");
    expect(RESOURCE_SCOPES).toHaveLength(YOTO_SCOPES.length - 1);
  });
});
