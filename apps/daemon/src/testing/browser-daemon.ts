// Process boundary for browser ownership tests. Launches the public daemon with an
// explicit test executable; production CLI startup still acquires the owned pin.
import { z } from "zod";
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
createDevThread(daemon.store, daemon.store.createWorkspace(process.cwd(), "Browser ownership"));
process.stdout.write(`ace daemon: ${daemon.url}\nToken file: ${daemon.tokenPath}\n`);
process.once("SIGTERM", () => {
  void daemon.close().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
});
