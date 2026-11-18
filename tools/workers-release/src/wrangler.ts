import type { WorkerPort } from "./deploy-run.ts";
import type { Run } from "./run-process.ts";
import {
  neverDeployed,
  parseDeployment,
  parseVersion,
  type Environment,
  type Live,
  type Release,
} from "./release.ts";

/*
 * The thin shell between a release and Cloudflare: each WorkerPort call is one wrangler command
 * in the Worker's directory, so wrangler reads that Worker's config, account and token.
 */

export function wranglerWorker(run: Run, cwd: string, environment: Environment): WorkerPort {
  const env = ["--env", environment];
  const wrangler = (args: readonly string[], capture: boolean) =>
    run("bun", ["x", "wrangler", ...args], { cwd, capture });
  const must = async (args: readonly string[]) => {
    const ran = await wrangler(args, false);
    if (ran.code !== 0) throw new Error(`wrangler ${args[0]} exited ${ran.code}`);
  };

  return {
    async live(): Promise<Live> {
      const status = await wrangler(["deployments", "status", "--json", ...env], true);
      if (status.code !== 0) {
        if (neverDeployed(status.output)) return { kind: "none" };
        throw new Error(`wrangler deployments status failed:\n${status.output}`);
      }
      const serving = parseDeployment(status.output).filter((entry) => entry.percentage > 0);
      const [only] = serving;
      if (serving.length !== 1 || !only)
        return { kind: "split", versionIds: serving.map((entry) => entry.versionId) };
      const view = await wrangler(["versions", "view", only.versionId, "--json", ...env], true);
      if (view.code !== 0) throw new Error(`wrangler versions view failed:\n${view.output}`);
      return { kind: "single", version: parseVersion(view.output) };
    },
    applyMigrations: (binding) => must(["d1", "migrations", "apply", binding, "--remote", ...env]),
    deploy: (release: Release) =>
      must(["deploy", ...env, "--tag", release.tag, "--message", release.message]),
    rollback: (versionId, message) =>
      must(["rollback", versionId, "--message", message, "--yes", ...env]),
  };
}
