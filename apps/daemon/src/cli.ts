import { diagnosticsCli } from "./diagnostics-cli.ts";
import { readConfig } from "./config.ts";
import { startDaemon } from "./index.ts";
import { createDevThread, stubHandler } from "./commands.ts";

const config = readConfig();
if (await diagnosticsCli(process.argv.slice(2), config)) {
  // Diagnostics exits without opening a daemon or its writable database.
} else {
  const development = process.env.ACE_DEV === "1";
  const daemon = await startDaemon(config, stubHandler({ development }));
  try {
    if (development && daemon.store.listThreads().length === 0) {
      const workspace = daemon.store.createWorkspace(process.cwd(), "Development");
      createDevThread(daemon.store, workspace);
    }
  } catch (error) {
    await daemon.close();
    throw error;
  }
  process.stdout.write(`ace daemon: ${daemon.url}\nToken file: ${daemon.tokenPath}\n`);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void daemon.close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
