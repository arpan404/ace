import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { git, scalar } from "./test-repo.ts";
import { quote } from "./credential-test-fixtures.ts";

export async function supportsNamedHooks(repo: string) {
  const marker = join(dirname(repo), "named-hook-probe");
  await scalar(repo, "config", "hook.ace-policy-probe.event", "pre-push");
  await scalar(
    repo,
    "config",
    "hook.ace-policy-probe.command",
    `printf supported > ${quote(marker)}`,
  );
  try {
    await git(
      repo,
      "-c",
      "hook.pre-push.enabled=true",
      "-c",
      "hook.ace-policy-probe.enabled=true",
      "hook",
      "run",
      "pre-push",
    ).catch(() => {});
    return await access(marker).then(
      () => true,
      () => false,
    );
  } finally {
    await scalar(repo, "config", "--remove-section", "hook.ace-policy-probe");
  }
}
