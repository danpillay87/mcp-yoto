/**
 * Best-effort cross-platform "open this URL in the default browser". Never
 * throws: the sign-in URL is always returned/printed alongside this call
 * too (see adapter.ts), so a headless box or a missing `xdg-open` degrades
 * to "copy this link" rather than a hard failure.
 */
import { spawn } from "node:child_process";

export function openInBrowser(url: string): void {
  try {
    let child: ReturnType<typeof spawn>;
    if (process.platform === "win32") {
      // NOT `cmd /c start`: cmd.exe parses the command line itself, and it
      // treats every unquoted `&` as a command separator -- an OAuth
      // authorize URL is full of `&`-joined query params, so `cmd start`
      // silently truncated the URL at the first `&` (client_id,
      // redirect_uri, code_challenge, state all dropped) and Yoto's sign-in
      // page rendered with no way to authenticate. `rundll32.exe
      // url.dll,FileProtocolHandler <url>` hands the URL to the shell's own
      // protocol handler with no cmd/shell parsing involved, so the URL
      // reaches Edge byte-for-byte.
      child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], {
        shell: false,
        detached: true,
        stdio: "ignore",
      });
    } else if (process.platform === "darwin") {
      child = spawn("open", [url], { shell: false, detached: true, stdio: "ignore" });
    } else {
      child = spawn("xdg-open", [url], { shell: false, detached: true, stdio: "ignore" });
    }
    // A missing binary (e.g. no xdg-open on a headless box) emits an async
    // `error` event rather than throwing -- swallow it the same way as the
    // synchronous catch below, since the URL is already on stderr for the
    // user to click (see login's stderr contract in adapter.ts).
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort only.
  }
}
