import { lstat } from "node:fs/promises";
import { AccountEnvKey, ProviderInstance, type AccountQuota } from "@ace/protocol/accounts";
import { instanceEnv } from "./instances.ts";
import { assertManagedHome } from "./managed-home.ts";
import { canonicalHome } from "./paths.ts";

/*
 * Startup reads every saved account's home folder before that account takes work: its canonical
 * path, that a managed home is still this installation's, that it is a folder. A folder on a
 * stalled disk or mount can leave that read unanswered for good, so each account is checked on its
 * own (ADR 0175): the rest answer, and only work bound to the stuck account waits for it.
 */

export type HomeProblem = NonNullable<AccountQuota["blockers"]["homeUnavailable"]>;

/**
 * Reads one account's home and returns its canonical identity, or throws why it is unusable.
 * `next` is the real read; a wrapper (tests, diagnostics) decides when to call it.
 */
export type HomeCheck = (
  instance: ProviderInstance,
  next: (instance: ProviderInstance) => Promise<ProviderInstance>,
) => Promise<ProviderInstance>;

export interface HomeCheckOptions {
  check?: HomeCheck;
  /** How long one unanswered home holds up the next account's check. */
  patienceMs?: number;
  /** Runs `run` after `ms`; returns a cancel. Injected so tests control time. */
  after?: (ms: number, run: () => void) => () => void;
}

/** A healthy home answers in milliseconds; one that hasn't after this is left running. */
export const homeCheckPatienceMs = 2_000;

/** The account's stored identity with its home and selector paths canonicalized. */
export async function canonicalInstance(input: ProviderInstance): Promise<ProviderInstance> {
  const parsed = ProviderInstance.parse(input);
  instanceEnv(parsed, {});
  if (parsed.implicit) return parsed;
  // Managed identities are immutable. validateHome refuses aliases instead of rewriting them.
  if (parsed.managed) return parsed;
  const homeDir = await canonicalHome(parsed.homeDir);
  const env: ProviderInstance["env"] = {};
  for (const key of Object.keys(parsed.env)) {
    const name = AccountEnvKey.parse(key);
    const value = parsed.env[name];
    if (value !== undefined) env[name] = await canonicalHome(value);
  }
  return ProviderInstance.parse({ ...parsed, homeDir, env });
}

/** The real read behind every check: canonical paths, then the home itself. */
export async function readHome(
  account: ProviderInstance,
  managedDataDir: string | undefined,
): Promise<ProviderInstance> {
  const instance = await canonicalInstance(account);
  // Startup revalidates repaired homes rather than trusting last startup's blocker.
  if (instance.managed) {
    if (!managedDataDir) throw new Error("Managed account needs its data root");
    await assertManagedHome(managedDataDir, instance);
  } else if (!instance.implicit && instance.provider !== "acp") {
    const stat = await lstat(instance.homeDir);
    if (!stat.isDirectory()) throw new Error("home_missing");
  }
  return instance;
}

/** Why a home check failed, in the registry's fixed words. Never "missing" for a read error. */
export function homeProblem(error: unknown): HomeProblem {
  const message = error instanceof Error ? error.message : undefined;
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (message === "foreign_home") return "foreign_home";
  if (message === "home_conflict") return "home_conflict";
  if (code === "ENOENT" || code === "ENOTDIR") return "home_missing";
  return "home_unreadable";
}

/** Settles once `task` does or `patienceMs` passes, whichever is first; never rejects. */
export function withinPatience(
  task: Promise<unknown>,
  patienceMs: number,
  after: NonNullable<HomeCheckOptions["after"]>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const cancel = after(patienceMs, resolve);
    const done = () => {
      cancel();
      resolve();
    };
    task.then(done, done);
  });
}

export function realAfter(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}
