import { findExecutable, parseVersion } from "@ace/provider-kit/discovery";
import { z } from "zod";
import type { ProviderInstallPlan } from "@ace/protocol";
import { installer } from "@ace/provider-kit/installers";
import type { InstallPlanner } from "./planner.ts";

const BrewInfo = z.object({
  formulae: z.array(z.object({ versions: z.object({ stable: z.string().nullable() }) })).optional(),
  casks: z.array(z.object({ version: z.string() })).optional(),
});
const Version = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
/** Stable releases only; a prerelease never makes a stable installed release look outdated. */
export function updateAvailable(installed: string, latest: string): boolean | undefined {
  const current = Version.safeParse(parseVersion("codex", installed));
  const next = Version.safeParse(latest);
  if (!current.success || !next.success || next.data.includes("-")) return undefined;
  const a = current.data.split(/[.+-]/).slice(0, 3).map(Number);
  const b = next.data.split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0);
  }
  return current.data.includes("-");
}
export class InstallVersions {
  private cache = new Map<string, { latest?: string; checkedAt: number; retryAt: number }>();
  private generations = new Map<string, number>();
  private flights = new Map<
    string,
    Promise<{ latestVersion?: string; versionCheckedAt?: number; updateAvailable?: boolean }>
  >();
  private planner: InstallPlanner;
  private now: () => number;
  constructor(planner: InstallPlanner, now: () => number) {
    this.planner = planner;
    this.now = now;
  }
  invalidate(plan: Pick<ProviderInstallPlan, "provider" | "agent">): void {
    for (const key of new Set([...this.cache.keys(), ...this.flights.keys()])) {
      if (!key.startsWith(`${plan.provider}:${plan.agent ?? ""}:`)) continue;
      this.cache.delete(key);
      this.flights.delete(key);
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    }
  }
  async check(
    plan: ProviderInstallPlan,
    signal?: AbortSignal,
  ): Promise<{ latestVersion?: string; versionCheckedAt?: number; updateAvailable?: boolean }> {
    const key = `${plan.provider}:${plan.agent ?? ""}:${plan.method ?? "npm"}`;
    const cached = this.cache.get(key);
    const fields = (row: typeof cached) => {
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
    if (cached && this.now() < cached.retryAt) return fields(cached);
    const flight = this.flights.get(key);
    if (flight) {
      await flight;
      return fields(this.cache.get(key));
    }
    const generation = this.generations.get(key) ?? 0;
    const work = this.latest(plan, signal)
      .then((latest) => {
        if (!signal?.aborted && (this.generations.get(key) ?? 0) === generation)
          this.cache.set(key, {
            ...(latest ? { latest } : cached?.latest ? { latest: cached.latest } : {}),
            checkedAt: latest ? this.now() : (cached?.checkedAt ?? this.now()),
            retryAt: this.now() + (latest ? 3_600_000 : 300_000),
          });
        return fields(this.cache.get(key));
      })
      .finally(() => {
        if (this.flights.get(key) === work) this.flights.delete(key);
      });
    this.flights.set(key, work);
    return work;
  }
  private async latest(
    plan: ProviderInstallPlan,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const spec = installer(plan.provider, plan.agent);
    if (!spec || spec.manual) return undefined;
    if (plan.method === "brew" && spec.brew) {
      const brew = await findExecutable("brew", this.planner.env);
      const raw =
        brew &&
        (await this.planner.probe(
          brew,
          ["info", "--json=v2", ...(spec.brew.cask ? ["--cask"] : []), spec.brew.name],
          signal,
        ));
      if (!raw) return undefined;
      try {
        const info = BrewInfo.parse(JSON.parse(raw));
        return Version.parse(info.casks?.[0]?.version ?? info.formulae?.[0]?.versions.stable);
      } catch {
        return undefined;
      }
    }
    const npm = spec.package && (await findExecutable("npm", this.planner.env));
    const raw =
      npm &&
      spec.package &&
      (await this.planner.probe(
        npm,
        ["view", spec.package, "version", "--registry=https://registry.npmjs.org"],
        signal,
      ));
    const parsed = Version.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }
}
