import { appKeyEnv, appKeyLineLimit, appKeyOnStdin, parseAppKeyLine } from "@ace/service/app-key";

/** How long `ace start` waits for the app's key line before starting without it. */
const appKeyWaitMs = 5_000;

interface KeyInput {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  once(event: "end" | "error", listener: () => void): unknown;
  destroy(): unknown;
}

/** Who started this daemon: its parent's pid now, and whether that process is the signed app. */
export interface Launcher {
  parent(): number;
  isApp(pid: number): Promise<boolean>;
}

/**
 * The desktop app's key for this daemon (ADR 0178 §12.8), when the app started it with
 * `ACE_APP_KEY=stdin`: one line on stdin, which the app closes after writing it. Any launcher
 * can set the flag and write a key, so the key counts only when this daemon's parent is the
 * signed app (`app-launcher.ts`), and the same process is still its parent once that is checked.
 * Anything else (no flag, another launcher, a malformed line, a stdin that stays open past the
 * wait) starts the daemon without a key, so the app's page is a host-token socket, as any other
 * client is. The flag goes from the environment either way, so nothing this daemon starts
 * inherits it.
 */
export async function readAppKey(
  env: NodeJS.ProcessEnv,
  /** Stdin, opened only when the app said a key is on it. */
  open: () => KeyInput,
  delay: (run: () => void, milliseconds: number) => () => void,
  launcher: Launcher,
): Promise<Uint8Array | undefined> {
  const asked = env[appKeyEnv] === appKeyOnStdin;
  delete env[appKeyEnv];
  if (!asked) return undefined;
  const parent = launcher.parent();
  const input = open();
  const text = await new Promise<string | undefined>((resolve) => {
    let read = "";
    let done = false;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      cancel();
      input.destroy();
      resolve(value);
    };
    const cancel = delay(() => finish(undefined), appKeyWaitMs);
    input.on("data", (chunk) => {
      read += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (read.length > appKeyLineLimit) finish(undefined);
    });
    input.once("end", () => finish(read));
    input.once("error", () => finish(undefined));
  });
  const key = text === undefined ? undefined : parseAppKeyLine(text);
  if (!key) return undefined;
  // A parent that exited meanwhile leaves this daemon to another process: no key then either.
  return (await launcher.isApp(parent)) && launcher.parent() === parent ? key : undefined;
}
