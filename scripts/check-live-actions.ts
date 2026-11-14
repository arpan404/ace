import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/*
 * Every web source that sends an action on what a thread copy shows (an answer, a Stop, a queue
 * change, a steer, an archive) is listed here with how it waits for current state: the shared
 * gate in `apps/web/src/lib/live-connection.ts` (`useThreadFreshness`, `useListFreshness`,
 * `currentNow`), a daemon fence, or a fresh read first. A new sender fails this check until it is
 * gated and listed, so no surface can act on stale state by forgetting the gate.
 */

const actions = [
  /type: "interaction\.resolve"/,
  /type: "thread\.interrupt"/,
  /type: "background_task\.stop"/,
  /type: "queue\.(edit|remove|move|resend|cancel|steer|pause|resume|clear)"/,
  /type: "thread\.archive"/,
  /delivery: "steer"/,
];

/** File (under apps/web/src) → how its sends are gated. */
const gated: Record<string, string> = {
  "features/thread/interactions/answer-sender.ts":
    "useAnswerSender: useThreadFreshness, checked as it sends; the daemon refuses a closed id",
  "features/palette/live-commands.ts": "approvals offered and sent only while useThreadFreshness",
  "features/thread/composer/use-thread-stop.ts": "canStop and isFresh; names runId or beforeSeq",
  "features/panels/agents/stop-agent.tsx": "useThreadFreshness; names the agent's run or cursor",
  "features/panels/work/summary-rows.tsx": "TaskStop: owning thread's freshness and node.stale",
  "features/panels/terminal/shell-resource.tsx": "useThreadFreshness of the shell's thread",
  "features/thread/composer/stop-strips.tsx": "useStopCommands: useThreadFreshness",
  "features/thread/items/background-task.tsx": "useThreadLiveState canStop and isFresh",
  "features/thread/composer/use-queue.ts":
    "useThreadFreshness checked as it sends; revision-fenced; queue-wide actions read first",
  "features/thread/sources/workspace-source.ts": "queue.resume at a revision read just before",
  "features/organize/use-thread-actions.ts":
    "currentNow(list) before archive and its Stop; interrupt names runId or beforeSeq",
  "features/thread/composer/send-message.ts":
    "a steer names its root run (runId); the daemon queues it if that run is over",
  "test/protocol-corpus.ts": "test corpus, not a surface",
};

const root = "apps/web/src/";
const files = execFileSync("git", ["ls-files", "--", `${root}*.ts`, `${root}*.tsx`], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter((path) => !/\.test\.tsx?$/.test(path));
const ungated: string[] = [];
const stale: string[] = [];
const seen = new Set<string>();
for (const path of files) {
  const text = readFileSync(path, "utf8");
  if (!actions.some((pattern) => pattern.test(text))) continue;
  const local = path.slice(root.length);
  seen.add(local);
  if (!(local in gated)) ungated.push(local);
}
for (const local of Object.keys(gated)) if (!seen.has(local)) stale.push(local);
if (ungated.length || stale.length) {
  for (const local of ungated)
    console.error(`${root}${local}: sends a live action; gate it and list it in this script`);
  for (const local of stale)
    console.error(`${root}${local}: listed but sends no live action; drop it from the list`);
  process.exit(1);
}
console.log(`live actions: ${seen.size} senders, all gated`);
