import type { Readable } from "node:stream";

/**
 * Set by the desktop app when it started this daemon on the PATH it saved last session, before
 * the login shell answered. The shell's PATH then follows as one line on stdin.
 */
export const loginPathPending = "ACE_LOGIN_PATH_PENDING";

/** The login shell may take its full 10 s; past this the daemon keeps the PATH it started on. */
export const loginPathWaitMs = 15_000;

/**
 * The PATH this daemon runs provider CLIs on, made final. With `ACE_LOGIN_PATH_PENDING` set it
 * waits for the desktop's line (`read`), at most until `timeout` settles, and puts it in
 * `env.PATH`. Resolves whether the PATH changed. Never rejects: an unreadable line, an early end
 * of input or a timeout all keep the PATH the daemon started with.
 */
export async function receiveLoginPath(input: {
  env: NodeJS.ProcessEnv;
  read: () => Promise<string | undefined>;
  timeout: Promise<void>;
}): Promise<boolean> {
  const { env } = input;
  if (env[loginPathPending] !== "1") return false;
  // Children of this daemon must not think a PATH is still on its way to them.
  delete env[loginPathPending];
  const line = await Promise.race([
    input.read().catch(() => undefined),
    input.timeout.then(() => undefined),
  ]);
  const path = line?.trim();
  if (!path || path === env.PATH) return false;
  env.PATH = path;
  return true;
}

/** The first line of `stream`, without its newline; undefined if it ends before one. */
export function firstLine(stream: Readable, maxBytes = 262_144): Promise<string | undefined> {
  return new Promise((resolve) => {
    let text = "";
    stream.setEncoding("utf8");
    const finish = (line: string | undefined) => {
      stream.off("data", data);
      stream.off("end", end);
      stream.off("error", end);
      // Nothing else is read from it: let the process exit without waiting on it.
      stream.destroy();
      resolve(line);
    };
    const data = (chunk: Buffer | string) => {
      text += String(chunk);
      const newline = text.indexOf("\n");
      if (newline >= 0) finish(text.slice(0, newline));
      else if (text.length > maxBytes) finish(undefined);
    };
    const end = () => finish(undefined);
    stream.on("data", data);
    stream.once("end", end);
    stream.once("error", end);
  });
}
