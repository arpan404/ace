// Offline provider boundary for abrupt daemon recovery tests. Never invokes a CLI.
import { deckFixture } from "./test-support.ts";
import { z } from "zod";
const args = z
  .tuple([z.string(), z.enum(["work", "switch"]), z.enum(["first", "recover"])])
  .parse(process.argv.slice(2));
const [home, scenario, mode] = args;
const h = await deckFixture({
  home,
  recover: mode === "recover",
  hold: scenario === "work" && mode === "first",
  crossProvider: scenario === "switch",
  quotaLimit: scenario === "switch" && mode === "first",
  onSend: (entry) => process.send?.({ type: "send", ...entry }),
  ...(mode === "first"
    ? {
        onSwitchClose: async (thread) => {
          process.send?.({ type: "boundary", thread });
          // A blocked provider close leaves a running switch with its old selection.
          await new Promise<void>(() => {});
        },
      }
    : {}),
});
if (mode === "first") {
  const result = await h.startRun();
  if (!result.ok) throw new Error(result.error);
}
await h.subscribe();
if (mode === "recover") {
  await h.settle();
  await h.advance(); // Replay the recovered switch after engine execution settles.
  const run = await h.waitFor((view) => view.phase === "done");
  process.send?.({ type: "done", run, sends: h.sends });
} else if (scenario === "work") {
  const run = await h.waitFor((view) =>
    view.lanes.some((lane) => lane.role === "worker" && lane.status === "working"),
  );
  process.send?.({ type: "boundary", run });
}
// Parent kills the process, including providers, sockets and SQLite, without shutdown.
process.on("message", () => {});
