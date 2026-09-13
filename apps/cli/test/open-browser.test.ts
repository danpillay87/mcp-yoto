import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Root cause (observed live on Windows 11): the win32 branch used to launch
 * via `cmd /c start "" <url>`. cmd.exe parses its own command line and
 * treats every unquoted `&` as a command separator, so an OAuth authorize
 * URL -- full of `&`-joined query params -- got truncated at the first `&`
 * before Edge ever saw it (client_id, redirect_uri, code_challenge, state
 * all dropped). These tests pin the fix: win32 must hand the URL to
 * `rundll32.exe url.dll,FileProtocolHandler` with no cmd/shell parsing, so
 * a URL containing `&` and `%`-escapes reaches the handler byte-for-byte.
 */

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

function fakeChildProcess() {
  const emitter = new EventEmitter() as EventEmitter & { unref: () => void };
  emitter.unref = vi.fn();
  return emitter;
}

const urlWithAmpersandsAndEscapes =
  "https://login.yotoplay.com/authorize?audience=https%3A%2F%2Fapi.yotoplay.com" +
  "&client_id=abc123&redirect_uri=http%3A%2F%2F127.0.0.1%3A8976%2Fcallback" +
  "&code_challenge=xyz%3D%3D&code_challenge_method=S256&state=foo%26bar&scope=offline_access";

describe("openInBrowser", () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    spawnMock.mockReset();
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    vi.resetModules();
  });

  function setPlatform(platform: string) {
    Object.defineProperty(process, "platform", { value: platform });
  }

  it("win32: spawns rundll32.exe with url.dll,FileProtocolHandler and the untouched URL, shell disabled", async () => {
    setPlatform("win32");
    spawnMock.mockReturnValue(fakeChildProcess());
    const { openInBrowser } = await import("../src/auth/open-browser.js");

    openInBrowser(urlWithAmpersandsAndEscapes);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnMock.mock.calls[0];
    expect(cmd).toBe("rundll32.exe");
    expect(args).toEqual(["url.dll,FileProtocolHandler", urlWithAmpersandsAndEscapes]);
    expect(options?.shell).toBeFalsy();
  });

  it("darwin: spawns `open` with the URL, shell disabled", async () => {
    setPlatform("darwin");
    spawnMock.mockReturnValue(fakeChildProcess());
    const { openInBrowser } = await import("../src/auth/open-browser.js");

    openInBrowser(urlWithAmpersandsAndEscapes);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnMock.mock.calls[0];
    expect(cmd).toBe("open");
    expect(args).toEqual([urlWithAmpersandsAndEscapes]);
    expect(options?.shell).toBeFalsy();
  });

  it("linux: spawns `xdg-open` with the URL, shell disabled", async () => {
    setPlatform("linux");
    spawnMock.mockReturnValue(fakeChildProcess());
    const { openInBrowser } = await import("../src/auth/open-browser.js");

    openInBrowser(urlWithAmpersandsAndEscapes);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnMock.mock.calls[0];
    expect(cmd).toBe("xdg-open");
    expect(args).toEqual([urlWithAmpersandsAndEscapes]);
    expect(options?.shell).toBeFalsy();
  });

  it("swallows an async spawn error instead of throwing/rejecting", async () => {
    setPlatform("win32");
    const child = fakeChildProcess();
    spawnMock.mockReturnValue(child);
    const { openInBrowser } = await import("../src/auth/open-browser.js");

    expect(() => {
      openInBrowser(urlWithAmpersandsAndEscapes);
      child.emit("error", new Error("spawn rundll32.exe ENOENT"));
    }).not.toThrow();
  });

  it("swallows a synchronous spawn throw", async () => {
    setPlatform("win32");
    spawnMock.mockImplementation(() => {
      throw new Error("spawn failed synchronously");
    });
    const { openInBrowser } = await import("../src/auth/open-browser.js");

    expect(() => openInBrowser(urlWithAmpersandsAndEscapes)).not.toThrow();
  });
});
