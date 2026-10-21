import { spawn } from "node:child_process";
import { findExecutable } from "@ace/provider-kit/discovery";

/** Host clipboard writers in preference order. Each reads the text from stdin. */
export function clipboardCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] }[] {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "clip", args: [] }];
  return [
    ...(env.WAYLAND_DISPLAY ? [{ command: "wl-copy", args: [] }] : []),
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

/** Returns false when no clipboard tool is available or it fails; never throws. */
export async function copyToClipboard(text: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const candidate of clipboardCommands(process.platform, env)) {
    const path = await findExecutable(candidate.command, env);
    if (!path) continue;
    const ok = await new Promise<boolean>((resolve) => {
      // pbcopy reads stdin as MacRoman without a UTF-8 locale.
      const child = spawn(path, candidate.args, {
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...env, LANG: env.LANG?.includes("UTF-8") ? env.LANG : "en_US.UTF-8" },
      });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
      child.stdin.on("error", () => resolve(false));
      child.stdin.end(text);
    });
    if (ok) return true;
  }
  return false;
}
