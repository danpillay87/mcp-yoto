/**
 * Best-effort cross-platform "open this URL in the default browser". Never
 * throws: the sign-in URL is always returned/printed alongside this call
 * too (see adapter.ts), so a headless box or a missing `xdg-open` degrades
 * to "copy this link" rather than a hard failure.
 */
import { spawn } from "node:child_process";

export function openInBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // `cmd /c start "" <url>` is the standard Windows incantation; the
      // empty title argument stops `start` from treating a quoted URL as the
      // window title. `windowsHide` suppresses the transient console flash.
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // Best-effort only.
  }
}
