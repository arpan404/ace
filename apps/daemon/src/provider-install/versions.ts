import { realpath } from "node:fs/promises";
import { findExecutable } from "@ace/provider-kit/discovery";
import { compareCliVersions, parseCliVersion } from "@ace/provider-kit/cli-versions";
import { z } from "zod";
import type { ProviderInstallPlan } from "@ace/protocol";
import { installer, type Installer } from "@ace/provider-kit/installers";
import type { InstallPlanner } from "./planner.ts";
import { brewName, parseRelease, platformPackage, ReleaseVersion } from "./release.ts";

const BrewInfo = z.object({
  formulae: z.array(z.object({ versions: z.object({ stable: z.string().nullable() }) })).optional(),
  casks: z.array(z.object({ version: z.string() })).optional(),
});
const registry = "--registry=https://registry.npmjs.org";
/** How long a registry answer stands. Vendors move `latest` minutes after publishing. */
export const versionFreshMs = 15 * 60_000;
/** How soon a failed or incomplete check is retried. */
export const versionRetryMs = 5 * 60_000;
/** An installed CLI newer than the cached latest means that answer is old; recheck, at most this often. */
const outrunRecheckMs = 60_000;

/** Stable releases only; a prerelease never makes a stable installed release look outdated. */
export function updateAvailable(installed: string, latest: string): boolean | undefined {
  const current = parseCliVersion(installed);
  const next = ReleaseVersion.safeParse(latest).success ? parseCliVersion(latest) : undefined;
  if (!current || !next || next.prerelease.length) return undefined;
  return compareCliVersions(next, current) > 0;
}
type Facts = { latestVersion?: string; versionCheckedAt?: number; updateAvailable?: boolean };
interface Source {
  key: string;
  spec: Installer;
  /** The dist-tag or Homebrew name the installation updates from. */
  target: string;
}
export class InstallVersions {
  private cache = new Map<string, { latest?: string; checkedAt: number; retryAt: number }>();
  private generations = new Map<string, number>();
  private flights = new Map<string, Promise<Facts>>();
  private planner: InstallPlanner;
  private now: () => number;
  constructor(planner: InstallPlanner, now: () => number) {
    this.planner = planner;
    this.now = now;
  }
  invalidate(plan: Pick<ProviderInstallPlan, "provider" | "agent">): void {
    this.forget((key) => key.startsWith(`${plan.provider}:${plan.agent ?? ""}:`));
  }
  /** Drops every answer, so the next check asks the registries again: the person's Refresh. */
  clear(): void {
    this.forget(() => true);
  }
  private forget(matches: (key: string) => boolean): void {
    for (const key of new Set([...this.cache.keys(), ...this.flights.keys()])) {
      if (!matches(key)) continue;
      this.cache.delete(key);
      this.flights.delete(key);
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    }
  }
  async check(plan: ProviderInstallPlan, signal?: AbortSignal): Promise<Facts> {
    const source = await this.source(plan);
    if (!source) return {};
    const { key } = source;
    const cached = this.cache.get(key);
    const fields = (row: typeof cached): Facts => {
      const available =
        row?.latest && plan.installedVersion
          ? updateAvailable(plan.installedVersion, row.latest)
          : undefined;
      return row?.latest
        ? {
            latestVersion: row.latest,
            versionCheckedAt: row.checkedAt,
            ...(available === undefined ? {} : { updateAvailable: available }),
          }
        : {};
    };
    if (cached && this.now() < cached.retryAt && !this.outrun(plan, cached)) return fields(cached);
    const flight = this.flights.get(key);
    if (flight) {
      await flight;
      return fields(this.cache.get(key));
    }
    const generation = this.generations.get(key) ?? 0;
    const work = this.latest(plan, source, signal)
      .then((latest) => {
        if (!signal?.aborted && (this.generations.get(key) ?? 0) === generation)
          this.cache.set(key, {
            ...(latest ? { latest } : cached?.latest ? { latest: cached.latest } : {}),
            checkedAt: latest ? this.now() : (cached?.checkedAt ?? this.now()),
            retryAt: this.now() + (latest ? versionFreshMs : versionRetryMs),
          });
        return fields(this.cache.get(key));
      })
      .finally(() => {
        if (this.flights.get(key) === work) this.flights.delete(key);
      });
    this.flights.set(key, work);
    return work;
  }
  /** The installed CLI is newer than the cached latest, and that answer is a minute old. */
  private outrun(plan: ProviderInstallPlan, row: { latest?: string; checkedAt: number }): boolean {
    const installed = parseCliVersion(plan.installedVersion);
    const latest = parseCliVersion(row.latest);
    return (
      !!installed &&
      !!latest &&
      compareCliVersions(installed, latest) > 0 &&
      this.now() - row.checkedAt >= outrunRecheckMs
    );
  }
  private async source(plan: ProviderInstallPlan): Promise<Source | undefined> {
    const spec = installer(plan.provider, plan.agent);
    if (!spec || spec.manual) return undefined;
    const method = plan.method ?? "npm";
    let target = "latest";
    if (method === "brew" && spec.brew) {
      const binary = plan.verify?.command;
      const resolved = binary?.includes("/")
        ? await realpath(binary).catch(() => binary)
        : undefined;
      target = brewName(spec, resolved) ?? spec.brew.name;
    } else if (plan.provider === "claude") target = (await this.planner.claudeChannel()) ?? target;
    return { key: `${plan.provider}:${plan.agent ?? ""}:${method}:${target}`, spec, target };
  }
  private async latest(
    plan: ProviderInstallPlan,
    { spec, target }: Source,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (plan.method === "brew" && spec.brew) {
      const brew = await findExecutable("brew", this.planner.env);
      const raw =
        brew &&
        (await this.planner.probe(
          brew,
          ["info", "--json=v2", ...(spec.brew.cask ? ["--cask"] : []), target],
          signal,
        ));
      if (!raw) return undefined;
      try {
        const info = BrewInfo.parse(JSON.parse(raw));
        return ReleaseVersion.parse(
          info.casks?.[0]?.version ?? info.formulae?.[0]?.versions.stable,
        );
      } catch {
        return undefined;
      }
    }
    if (!spec.package) return undefined;
    // A script install still reads the registry the vendor publishes to, with either manager.
    const [npm, bun] = await Promise.all([
      plan.method === "bun" ? undefined : findExecutable("npm", this.planner.env),
      findExecutable("bun", this.planner.env),
    ]);
    const manager = npm ? { path: npm, bun: false } : bun ? { path: bun, bun: true } : undefined;
    if (!manager) return undefined;
    const ask = (name: string, fields: readonly string[]) =>
      this.planner.probe(
        manager.path,
        manager.bun ? ["info", name, ...fields, registry] : ["view", name, ...fields, registry],
        signal,
      );
    // Only the two fields: Bun's whole manifest runs past the probe's output limit.
    const release = parseRelease(
      await ask(`${spec.package}@${target}`, ["version", "optionalDependencies", "--json"]),
    );
    if (!release) return undefined;
    if (!plan.installedVersion || !updateAvailable(plan.installedVersion, release.version))
      return release.version;
    // Offer it only once this computer's binary is out; until then the install would fail.
    const { platform, arch } = this.planner.host;
    const binary = platformPackage(spec.package, release, platform, arch);
    if (binary && !(await ask(binary, ["version"]))?.trim()) return undefined;
    return release.version;
  }
}
