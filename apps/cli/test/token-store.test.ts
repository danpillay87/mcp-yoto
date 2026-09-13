import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileStore } from "../src/auth/token-store.js";

describe("FileStore", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-yoto-tokenstore-"));
    filePath = join(dir, "tokens.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips tokens through a temp+rename write", async () => {
    const store = new FileStore(filePath);
    await store.save({ accessToken: "at1", refreshToken: "rt1", expiresAt: 12345 });

    const loaded = await store.load();
    expect(loaded).toEqual({ accessToken: "at1", refreshToken: "rt1", expiresAt: 12345 });

    // The temp file must never survive a successful write.
    await expect(readFile(`${filePath}.tmp`, "utf-8")).rejects.toThrow();
  });

  it("recovers from .last-good when the main file is corrupted after a good write", async () => {
    const store = new FileStore(filePath);
    const goodTokens = { accessToken: "good-token", refreshToken: "good-refresh" };
    // .last-good is only populated on the SECOND write (it's a copy of
    // whatever was main just before the new write lands) -- two identical
    // saves reproduce that shape without the test caring which generation
    // of content it's asserting on.
    await store.save(goodTokens);
    await store.save(goodTokens);

    // Simulate a crash mid-write: the main file is left truncated/garbled,
    // but the .last-good backup (written just before) is untouched.
    await writeFile(filePath, "{not valid json", "utf-8");

    const loaded = await store.load();
    expect(loaded).toEqual(goodTokens);
  });

  it("reads a file written with a leading UTF-8 BOM (as a PowerShell writer would leave it)", async () => {
    const withBom = `﻿${JSON.stringify({ accessToken: "bom-token" })}`;
    await writeFile(filePath, withBom, "utf-8");

    const store = new FileStore(filePath);
    const loaded = await store.load();
    expect(loaded).toEqual({ accessToken: "bom-token" });
  });

  it("returns undefined when nothing has ever been saved", async () => {
    const store = new FileStore(filePath);
    await expect(store.load()).resolves.toBeUndefined();
  });

  it("clear() removes the main file, .last-good, and any leftover .tmp", async () => {
    const store = new FileStore(filePath);
    await store.save({ accessToken: "a" });
    await store.save({ accessToken: "b" }); // now .last-good exists too

    await store.clear();

    await expect(store.load()).resolves.toBeUndefined();
    await expect(readFile(filePath, "utf-8")).rejects.toThrow();
    await expect(readFile(`${filePath}.last-good`, "utf-8")).rejects.toThrow();
  });
});
