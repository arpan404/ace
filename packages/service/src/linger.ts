import { z } from "zod";
import { checked, type Runner } from "./process.ts";
export async function enableLinger(platform: string, uid: number, run: Runner): Promise<void> {
  if (platform === "win32")
    throw new Error(
      "--linger is not available on Windows: ace's task runs while you are logged on.",
    );
  if (platform !== "linux") throw new Error("--linger requires Linux systemd");
  z.number().int().nonnegative().parse(uid);
  await checked(run, "loginctl", ["enable-linger", String(uid)]);
}
