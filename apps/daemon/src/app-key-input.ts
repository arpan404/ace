import { appKeyEnv, appKeyLineLimit, appKeyOnStdin, parseAppKeyLine } from "@ace/service/app-key";

/** How long `ace start` waits for the app's key line before starting without it. */
const appKeyWaitMs = 5_000;

interface KeyInput {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  once(event: "end" | "error", listener: () => void): unknown;
  destroy(): unknown;
}

/**
 * The desktop app's key for this daemon (ADR 0178 §12.8), when the app started it with
 * `ACE_APP_KEY=stdin`: one line on stdin, which the app closes after writing it. Anything else
 * (no flag, a malformed line, a stdin that stays open past the wait) starts the daemon without
 * a key, so the app's page is a host-token socket, as any other client is. The flag goes from
 * the environment either way, so nothing this daemon starts inherits it.
 */
export async function readAppKey(
  env: NodeJS.ProcessEnv,
  /** Stdin, opened only when the app said a key is on it. */
  open: () => KeyInput,
  delay: (run: () => void, milliseconds: number) => () => void,
): Promise<Uint8Array | undefined> {
  const asked = env[appKeyEnv] === appKeyOnStdin;
  delete env[appKeyEnv];
  if (!asked) return undefined;
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
  return text === undefined ? undefined : parseAppKeyLine(text);
}
