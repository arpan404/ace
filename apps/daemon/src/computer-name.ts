import { execFile } from "node:child_process";
import { hostname } from "node:os";

/** Read the OS name once per server, with bounded output and a plain fallback. */
export async function computerName(): Promise<string> {
  if (process.platform === "darwin") {
    const name = await new Promise<string>((resolve) => {
      execFile(
        "/usr/sbin/scutil",
        ["--get", "ComputerName"],
        { timeout: 2000, maxBuffer: 4096 },
        (error, stdout) => resolve(error ? "" : stdout.trim()),
      );
    });
    if (name && name.length <= 256) return name;
  }
  return (
    hostname()
      .replace(/\.local$/i, "")
      .replace(/-/g, " ") || "This machine"
  );
}
