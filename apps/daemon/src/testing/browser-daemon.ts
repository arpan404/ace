// Process boundary for browser ownership tests. Launches the public daemon with an
// explicit test executable; production CLI startup still acquires the owned pin.
import { z } from "zod";
import { Agent } from "@ace/protocol";
import { startDaemon } from "../index.ts";
import { readConfig } from "../config.ts";
import { createDevThread, stubHandler } from "../commands.ts";

const [executablePath] = z.tuple([z.string().min(1)]).parse(process.argv.slice(2));
const daemon = await startDaemon({
  config: readConfig(),
  handler: stubHandler({ development: true }),
  browser: { executablePath },
  history: { instances: [] },
});
const thread =
  daemon.store.listThreads()[0] ??
  createDevThread(daemon.store, daemon.store.createWorkspace(process.cwd(), "Browser ownership"));
if (!thread.rootAgentId)
  daemon.store.appendEvents(
    thread.id,
    [
      {
        type: "agent.created",
        agent: Agent.parse({
          id: "browser-fixture-root",
          threadId: thread.id,
          parentId: null,
          origin: "root",
          native: { provider: "codex" },
          fidelity: "full",
          cwd: process.cwd(),
          status: { state: "working", activity: "tool" },
          createdAt: 1,
        }),
      },
    ],
    1,
  );
process.stdout.write(`ace daemon: ${daemon.url}\nToken file: ${daemon.tokenPath}\n`);
process.once("SIGTERM", () => {
  void daemon.close().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
});
