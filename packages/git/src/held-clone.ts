import { textOutput, type GitCli } from "./cli.ts";
import type { CloneOptions } from "./projects.ts";

const progressLine = /^(Receiving objects|Resolving deltas|Updating files):\s+(\d{1,3})%/;
const phases = {
  "Receiving objects": "receiving",
  "Resolving deltas": "resolving",
  "Updating files": "checkout",
} as const;

/** Numeric progress only: never URLs, helper output or credential diagnostics. */
function progress(report: CloneOptions["progress"]) {
  let pending = "";
  let previous = "";
  return (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split(/[\r\n]/);
    pending = (lines.pop() ?? "").slice(-4096);
    for (const line of lines) {
      const match = progressLine.exec(line);
      const phase = match?.[1];
      if (phase === undefined || line === previous) continue;
      const percent = Number(match?.[2]);
      if (percent > 100) continue;
      previous = line;
      report({ phase: phases[phase as keyof typeof phases], percent });
    }
  };
}

/**
 * Windows: a clone into a held folder, as init, remote, fetch and checkout. The folder's `.git`
 * entry exists before Git starts (it keeps the folder from becoming a junction), and
 * `git clone` refuses a destination that already has one.
 */
export async function cloneInSteps(
  cli: GitCli,
  input: CloneOptions,
  protocols: readonly string[],
  env: Record<string, string>,
): Promise<void> {
  const at = {
    directoryFd: input.directoryFd,
    signal: input.signal,
    ...(input.transfer ? { timeoutMs: input.transfer.timeoutMs } : {}),
  };
  const guard = [
    "-c",
    "protocol.allow=never",
    ...protocols.flatMap((protocol) => ["-c", `protocol.${protocol}.allow=always`]),
  ];
  const report = progress(input.progress);
  await cli.call(input.path, ["init", "--quiet", "--", "."], { write: true, ...at });
  await cli.call(input.path, ["remote", "add", "origin", input.url], { write: true, ...at });
  await cli.call(input.path, [...guard, "fetch", "--progress", "origin"], {
    write: true,
    env,
    captureBytes: 4096,
    stderr: report,
    ...at,
  });
  // An empty remote has no HEAD; the clone then stays on an unborn branch, as `git clone` does.
  await cli.call(input.path, [...guard, "remote", "set-head", "origin", "--auto"], {
    write: true,
    env,
    allowFailure: true,
    captureBytes: 4096,
    ...at,
  });
  const head = await cli.call(
    input.path,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { allowFailure: true, ...at },
  );
  if (head.exitCode !== 0) return;
  const tracked = textOutput(head);
  const branch = tracked.slice("origin/".length);
  await cli.call(input.path, ["checkout", "--progress", "-B", branch, "--track", tracked], {
    write: true,
    captureBytes: 4096,
    stderr: report,
    ...at,
  });
}
