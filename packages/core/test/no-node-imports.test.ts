import { describe, expect, it } from "vitest";

/**
 * packages/core must stay runtime-agnostic (fetch + WebCrypto only) so it
 * runs unchanged in the Cloudflare Worker and the Node CLI -- biome's
 * `noRestrictedImports` override already blocks `node:*`/bare-Node-builtin
 * imports at lint time (see biome.json), but this test is the belt-and-
 * braces check the plan asks for, independent of lint config drifting.
 *
 * Uses Vite's `import.meta.glob` (raw text import) rather than `node:fs` to
 * read the source files, precisely so this test file itself doesn't need
 * an exemption from the same rule it's checking.
 */
const sourceFiles = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("packages/core stays runtime-agnostic", () => {
  it("found source files to check (the glob itself didn't silently match nothing)", () => {
    expect(Object.keys(sourceFiles).length).toBeGreaterThan(5);
  });

  it("contains no node:* imports or require() calls anywhere under src/", () => {
    const offenders: string[] = [];
    for (const [path, content] of Object.entries(sourceFiles)) {
      if (
        /from\s+["']node:[a-z_/]+["']/.test(content) ||
        /\brequire\(\s*["'][^"']+["']\s*\)/.test(content)
      ) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("contains no bare Node builtin imports (fs, path, crypto, os, http, child_process, net)", () => {
    const bareBuiltins = ["fs", "path", "crypto", "os", "http", "child_process", "net"];
    const offenders: string[] = [];
    for (const [path, content] of Object.entries(sourceFiles)) {
      for (const builtin of bareBuiltins) {
        const pattern = new RegExp(`from\\s+["']${builtin}["']`);
        if (pattern.test(content)) offenders.push(`${path} imports "${builtin}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
