import type { Readable } from "node:stream";
import {
  decodeLoginPathLine,
  loginPathPending,
  PendingLoginPath,
  prefixedPath,
} from "@ace/service/login-path";

/** The app's own login shell may take its full 10 s; past this the daemon asks the shell itself. */
export const loginPathWaitMs = 15_000;

/**
 * The PATH of a daemon the desktop app started on last launch's saved PATH, before the login
 * shell answered (`@ace/service/login-path`). The saved PATH is never used to read provider
 * CLIs: `final` waits for the login shell's, from the app or, when the app's never comes, from
 * the daemon's own lookup.
 */
export interface LoginPath {
  /** Settles once PATH is final, with whether it changed; never rejects. */
  final: Promise<boolean>;
  /**
   * Called with the final PATH, if it changed, before `final` settles: environments copied
   * before then take it too.
   */
  onChange(apply: (path: string) => void): void;
}

/** Keeps `copy`'s PATH the daemon's final one; returns `copy`. */
export function followLoginPath(
  loginPath: LoginPath | undefined,
  copy: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  loginPath?.onChange((path) => {
    copy.PATH = path;
  });
  return copy;
}

/**
 * Undefined for a daemon nobody promised a PATH to: it never waits. Otherwise the first login
 * shell PATH to arrive becomes final, and the other is ignored, so providers are read once:
 * the app's line on stdin (`read`), or, once stdin ends without one or `timeout` passes, the
 * daemon's own `lookup` of the login shell, exactly as the app would have asked it.
 */
export function receiveLoginPath(input: {
  env: NodeJS.ProcessEnv;
  read: () => Promise<string | undefined>;
  timeout: () => Promise<void>;
  lookup: (pending: PendingLoginPath) => Promise<string>;
  log?: (message: string) => void;
}): LoginPath | undefined {
  const { env } = input;
  const raw = env[loginPathPending];
  if (raw === undefined) return undefined;
  // Children of this daemon must not think a PATH is still on its way to them.
  delete env[loginPathPending];
  const pending = parsePending(raw) ?? { inherited: env.PATH ?? "" };
  const listeners: ((path: string) => void)[] = [];
  let settled: { changed: boolean } | undefined;
  const final = Promise.withResolvers<boolean>();
  const settle = (path: string) => {
    if (settled) return;
    const changed = path !== env.PATH;
    settled = { changed };
    if (changed) {
      env.PATH = path;
      // One environment that fails to take the PATH must not keep the others, or providers,
      // from it: each failure is reported, and `final` always settles.
      for (const listener of listeners)
        try {
          listener(path);
        } catch (error) {
          input.log?.(`An environment could not take the login shell's PATH: ${String(error)}`);
        }
    }
    final.resolve(changed);
  };
  let looking = false;
  const lookUp = (reason: string) => {
    if (settled || looking) return;
    looking = true;
    input.log?.(`Reading the login shell's PATH: ${reason}`);
    input.lookup(pending).then(settle, (error: unknown) => {
      // The lookup answers the app's own PATH when the shell fails, as the app would have used;
      // a rejection is a defect, answered the same way. Never the saved PATH.
      input.log?.(`The login shell's PATH could not be read: ${String(error)}`);
      settle(prefixedPath(pending.prefix, pending.inherited));
    });
  };
  input.read().then(
    (line) => {
      const path = line === undefined ? undefined : decodeLoginPathLine(line);
      if (path) settle(path);
      else lookUp(line === undefined ? "the app sent none" : "the app's line was unreadable");
    },
    () => lookUp("the app's line was unreadable"),
  );
  void input.timeout().then(() => lookUp("the app did not send it in time"));
  return {
    final: final.promise,
    onChange(apply) {
      if (!settled) listeners.push(apply);
      // Registered late: the caller's own call, so its failure is the caller's to see.
      else if (settled.changed) apply(env.PATH ?? "");
    },
  };
}

function parsePending(raw: string): PendingLoginPath | undefined {
  try {
    const parsed = PendingLoginPath.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The first line of `stream`, without its newline; undefined if it ends before one. */
export function firstLine(stream: Readable, maxBytes = 1_048_576): Promise<string | undefined> {
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
