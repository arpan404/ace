import { stat } from "node:fs/promises";

/**
 * A file changed this recently may change again within the filesystem's timestamp granularity
 * without its stamp moving, so a snapshot is only trusted once every source is older than this.
 */
export const settleMs = 2_000;
const capacity = 256;

/** Environment that never changes what Git reads as configuration or which checkout it finds. */
const configNeutral = new Set([
  "GIT_INDEX_FILE",
  "GIT_LITERAL_PATHSPECS",
  "GIT_OPTIONAL_LOCKS",
  "GIT_TERMINAL_PROMPT",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
]);

/** The part of a call's environment that can change Git's configuration sources. */
export function configEnvironment(env: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => !configNeutral.has(key))
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export interface ConfigFactsOptions {
  /** The files to stamp for `cwd`, learned by asking Git; undefined when that can't be known. */
  sources(cwd: string, env: Record<string, string>): Promise<string[] | undefined>;
  /** Wall clock in epoch milliseconds, comparable with file timestamps. */
  now(): number;
}

interface Snapshot {
  paths: string[];
  stamp: string;
  values: Map<string, unknown>;
}

async function stampOf(paths: readonly string[]) {
  let newest = 0;
  const parts: string[] = [];
  for (const path of paths) {
    try {
      const info = await stat(path, { bigint: true });
      // A directory's times move with every lock file inside it; only its identity matters.
      if (info.isDirectory()) parts.push(`d:${info.dev}:${info.ino}`);
      else {
        newest = Math.max(newest, Number(info.mtimeMs), Number(info.ctimeMs));
        parts.push(
          `f:${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
        );
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      parts.push("-");
    }
  }
  return { stamp: parts.join("\0"), newest };
}

/**
 * Facts derived only from a checkout's Git configuration and discovery (its root, remotes,
 * configured filter drivers and hooks), kept until any file Git would read them from changes.
 * A value is kept only when every source stamped identically before and after it was computed,
 * so a change during the computation is never hidden. Nothing is kept for a checkout whose
 * sources Git can't name.
 */
export class ConfigFacts {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly learning = new Map<string, Promise<Snapshot | undefined>>();
  /** When a checkout whose sources were too fresh to trust is worth asking about again. */
  private readonly settling = new Map<string, number>();
  private readonly options: ConfigFactsOptions;

  constructor(options: ConfigFactsOptions) {
    this.options = options;
  }

  async read<T>(
    cwd: string,
    env: Record<string, string>,
    name: string,
    compute: () => Promise<T>,
    keep: (value: T) => boolean = () => true,
  ): Promise<T> {
    const key = `${cwd}\0${JSON.stringify(env)}`;
    const { snapshot, checked } = await this.snapshot(key);
    if (!snapshot) {
      // Sources are learned only after a computation succeeds, so a first call starts exactly the
      // commands it always did and a failing one never adds more. The next call can keep a value.
      const value = await compute();
      await this.learnOnce(key, cwd, env);
      return value;
    }
    if (snapshot.values.has(name)) {
      // A snapshot learned for another caller was stamped before this call began.
      if (!checked && (await stampOf(snapshot.paths))?.stamp !== snapshot.stamp) return compute();
      return structuredClone(snapshot.values.get(name) as T);
    }
    const value = await compute();
    const after = await stampOf(snapshot.paths);
    if (after?.stamp === snapshot.stamp && keep(value) && this.snapshots.get(key) === snapshot)
      snapshot.values.set(name, structuredClone(value));
    return value;
  }

  /** The checkout's snapshot if its sources are unchanged; one being learned is joined. */
  private async snapshot(
    key: string,
  ): Promise<{ snapshot: Snapshot | undefined; checked: boolean }> {
    const known = this.snapshots.get(key);
    if (known) {
      if ((await stampOf(known.paths))?.stamp === known.stamp)
        return { snapshot: known, checked: true };
      if (this.snapshots.get(key) === known) this.snapshots.delete(key);
    }
    const joined = this.learning.get(key);
    return { snapshot: joined ? await joined : undefined, checked: false };
  }

  private async learnOnce(key: string, cwd: string, env: Record<string, string>) {
    if (this.snapshots.has(key)) return;
    const joined = this.learning.get(key);
    if (joined) return void (await joined);
    // Sources still settling: asking Git again before then can't produce a snapshot either.
    const settling = this.settling.get(key);
    if (settling !== undefined) {
      if (this.options.now() < settling) return;
      this.settling.delete(key);
    }
    const flight = this.learn(key, cwd, env).finally(() => this.learning.delete(key));
    this.learning.set(key, flight);
    await flight;
  }

  private async learn(key: string, cwd: string, env: Record<string, string>) {
    const started = this.options.now();
    const paths = await this.options.sources(cwd, env).catch(() => undefined);
    if (!paths) return undefined;
    const stamped = await stampOf(paths);
    // Anything written since just before Git listed the sources may hold an include it didn't see.
    if (!stamped) return undefined;
    if (stamped.newest >= started - settleMs) {
      this.settling.set(key, Math.max(started, stamped.newest) + settleMs);
      if (this.settling.size > capacity) this.settling.clear();
      return undefined;
    }
    const snapshot: Snapshot = { paths, stamp: stamped.stamp, values: new Map() };
    this.snapshots.delete(key);
    this.snapshots.set(key, snapshot);
    for (const oldest of this.snapshots.keys()) {
      if (this.snapshots.size <= capacity) break;
      this.snapshots.delete(oldest);
    }
    return snapshot;
  }
}
