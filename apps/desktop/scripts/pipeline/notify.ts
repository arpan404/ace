#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { releaseSummary } from "../../src/packaging/release-summary.ts";
import { say, step, summary } from "./github.ts";

/**
 * Tells the owner how a release run ended (ADR 0188), on omarchy, whatever happened before:
 *
 *   NEEDS='${{ toJSON(needs) }}' node apps/desktop/scripts/pipeline/notify.ts <tag> <run url> <job>...
 *
 * The jobs are named in pipeline order, so the message names the first one that failed. The
 * message goes to the run's summary page and to the runner's notify hook: the executable named
 * by `ACE_RELEASE_NOTIFY` in the runner's environment, called with the title and the body. The
 * ace CLI has no notify command yet; when it gets one, the hook calls it. Without a hook the
 * summary page and GitHub's own failure email are all the owner gets.
 */
const Needs = z.record(
  z.string(),
  z.looseObject({ result: z.enum(["success", "failure", "cancelled", "skipped"]) }),
);

step(async () => {
  const [tag = "", url = "", ...order] = process.argv.slice(2);
  const needs = Needs.parse(JSON.parse(process.env.NEEDS ?? "{}"));
  const jobs = order.map((job) => ({ job, result: needs[job]?.result ?? "skipped" }));
  const message = releaseSummary({ tag, jobs, url });
  summary(`## ${message.title}\n\n${message.body}`);
  say(`${message.title}: ${message.body}`);
  const hook = process.env.ACE_RELEASE_NOTIFY;
  if (!hook) {
    say("no ACE_RELEASE_NOTIFY hook on this runner; the run's summary page has the result");
    return;
  }
  const sent = spawnSync(hook, [message.title, message.body], {
    stdio: "inherit",
    timeout: 60_000,
  });
  // A notification that didn't go out doesn't change how the release went.
  if (sent.status !== 0)
    console.log(`::warning::The notify hook exited with ${sent.status ?? sent.signal}`);
});
