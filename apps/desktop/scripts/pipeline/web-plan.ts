#!/usr/bin/env node
import { z } from "zod";
import { webDeployPlan } from "../../src/packaging/web-deploy.ts";
import { gh, output, say, step, summary, tagArgument, tagCommit } from "./github.ts";

/**
 * Plans the release's web app deploy (ADR 0188), on omarchy with the tag's commit checked out:
 *
 *   node apps/desktop/scripts/pipeline/web-plan.ts <tag>
 *
 * Reads the tag's commit and the published releases; `webDeployPlan` decides. Outputs `deploy`
 * (`true` or `false`) and, to deploy, `version`, `branch`, `commit` and `message`. The workflow
 * then builds `apps/web` with `ACE_VERSION=<version>` and runs `wrangler pages deploy`; this
 * step never sees the Cloudflare token.
 */
const Releases = z.array(z.object({ tagName: z.string(), isDraft: z.boolean() }));

step(async () => {
  const tag = tagArgument();
  const commit = tagCommit(tag);
  const gated = process.env.RELEASE_COMMIT;
  if (gated && gated !== commit)
    throw new Error(
      `${tag} points at ${commit.slice(0, 12)}, not the ${gated.slice(0, 12)} the gate checked`,
    );
  const releases = Releases.parse(
    JSON.parse(gh(["release", "list", "--limit", "1000", "--json", "tagName,isDraft"])),
  );
  const published = releases.filter((release) => !release.isDraft).map((r) => r.tagName);
  const plan = webDeployPlan({ tag, commit, published });

  output("deploy", String(plan.action === "deploy"));
  if (plan.action === "skip") {
    say(`not deploying the web app: ${plan.reason}`);
    summary(`Web app not deployed: ${plan.reason}.`);
    return;
  }
  output("version", plan.version);
  output("branch", plan.branch);
  output("commit", commit);
  output("message", plan.message);
  summary(`Web app **${plan.version}** to ${plan.site} (Pages branch \`${plan.branch}\`).`);
});
