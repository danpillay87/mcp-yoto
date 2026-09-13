/**
 * Where the CLI's Yoto credential lives at rest: the OS keychain by
 * preference (`KeyringStore`, via `@napi-rs/keyring`), falling back to a
 * plain file (`FileStore`) when the keychain is unusable (no native
 * binding for this platform, a headless box with no keyring daemon, a
 * locked session). `createTokenStore()` is the one entry point that makes
 * that choice; everything else in this file is a plain, directly testable
 * `TokenStore` implementation.
 */
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "@mcp-yoto/core";

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** Unix milliseconds. Belt-and-braces alongside the JWT's own `exp` claim -- see session.ts. */
  expiresAt?: number;
  /** Space-separated scopes Yoto actually granted. */
  scope?: string;
}

export interface TokenStore {
  readonly kind: "keychain" | "file";
  load(): Promise<StoredTokens | undefined>;
  save(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

const SERVICE = "mcp-yoto";

/**
 * OS keychain-backed store (Windows Credential Manager / macOS Keychain /
 * Secret Service on Linux) via `@napi-rs/keyring`.
 *
 * Imports the native module dynamically and lazily -- it's an
 * `optionalDependency` (see apps/cli/package.json), so a platform with no
 * prebuilt binding must still be able to `npm install` and run; the failure
 * surfaces here, at first use, and `createTokenStore()` catches it.
 */
export class KeyringStore implements TokenStore {
  readonly kind = "keychain" as const;

  constructor(private readonly account: string) {}

  private async entry(): Promise<import("@napi-rs/keyring").AsyncEntry> {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(SERVICE, this.account);
  }

  async load(): Promise<StoredTokens | undefined> {
    const entry = await this.entry();
    const raw = await entry.getPassword();
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredTokens;
    } catch {
      return undefined;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    const entry = await this.entry();
    await entry.setPassword(JSON.stringify(tokens));
  }

  async clear(): Promise<void> {
    const entry = await this.entry();
    await entry.deletePassword();
  }
}

/** `~/.config/mcp-yoto/tokens.json`, or on Windows `%APPDATA%\mcp-yoto\tokens.json`. */
export function defaultTokenFilePath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "mcp-yoto", "tokens.json");
  }
  return join(homedir(), ".config", "mcp-yoto", "tokens.json");
}

/**
 * Plain-file fallback: crash-safe temp+rename writes with a `.last-good`
 * backup (ported from the old yoto-mcp-server's config store), 0600
 * permissions on POSIX (Windows ACLs already scope the file to the current
 * user's profile), and BOM-tolerant reads (a PowerShell-written file often
 * carries a UTF-8 BOM, which breaks a naive `JSON.parse`).
 */
export class FileStore implements TokenStore {
  readonly kind = "file" as const;
  private readonly filePath: string;

  constructor(filePath: string = defaultTokenFilePath()) {
    this.filePath = filePath;
  }

  async load(): Promise<StoredTokens | undefined> {
    const primary = await this.readFrom(this.filePath);
    if (primary) return primary;
    // The main file is missing or corrupt (e.g. a crash mid-write left a
    // truncated .tmp that never got renamed, or a partial write slipped
    // through) -- recover from the last file we know was ever written cleanly.
    return this.readFrom(`${this.filePath}.last-good`);
  }

  private async readFrom(path: string): Promise<StoredTokens | undefined> {
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      return undefined;
    }
    const stripped = raw.replace(/^﻿/, "");
    try {
      return JSON.parse(stripped) as StoredTokens;
    } catch {
      return undefined;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await copyFile(this.filePath, `${this.filePath}.last-good`);
    } catch {
      // No existing file yet -- this is the first sign-in.
    }
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(tokens, null, 2), "utf-8");
    await rename(tmp, this.filePath);
    if (process.platform !== "win32") {
      await chmod(this.filePath, 0o600);
    }
  }

  async clear(): Promise<void> {
    for (const path of [this.filePath, `${this.filePath}.last-good`, `${this.filePath}.tmp`]) {
      try {
        await rm(path);
      } catch {
        // Already gone -- clearing an already-signed-out store is not an error.
      }
    }
  }
}

export interface CreateTokenStoreOptions {
  /** Keychain account name -- the client id, per the plan's "service mcp-yoto, account = client id". */
  account: string;
  logger: Logger;
  /** Forces a `FileStore` at this exact path, skipping the keychain entirely. See config.ts's `tokenFileOverride`. */
  fileOverride?: string;
}

/**
 * Picks the token store for this run: the OS keychain when it works, a
 * plain file (with one loud stderr warning, surfaced again in
 * `yoto_status`) when it doesn't.
 *
 * The probe is `load()` itself: on a fresh machine with nothing stored yet,
 * `getPassword()` resolves to `undefined` rather than throwing (see
 * @napi-rs/keyring's own contract), so an empty-but-working keychain is
 * correctly told apart from a broken one.
 */
export async function createTokenStore(options: CreateTokenStoreOptions): Promise<TokenStore> {
  if (options.fileOverride) {
    return new FileStore(options.fileOverride);
  }
  try {
    const keyring = new KeyringStore(options.account);
    await keyring.load();
    return keyring;
  } catch (error) {
    const filePath = defaultTokenFilePath();
    options.logger.warn(
      `System keychain unavailable -- falling back to a local file at ${filePath} ` +
        "(0600 permissions on macOS/Linux; scoped to your Windows user profile).",
      { error: error instanceof Error ? error.message : String(error) },
    );
    return new FileStore(filePath);
  }
}
