import { startDaemon, readConfig } from "@ace/daemon";

// The real engine, as `ace daemon start` runs it: provider discovery included. PATH holds only
// the fake CLIs startup-clients.ts writes, never a person's own.
const daemon = await startDaemon({
  config: readConfig(),
  modelInstances: [],
  notificationChannels: {},
  toolkits: [],
});
const close = () =>
  void daemon.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
// Priming: a first launch records what it does once (default accounts, settings), so the
// measured start is a restart.
if (process.env.ACE_BENCH_PRIME === "1") close();
process.on("message", (input: unknown) => {
  if (typeof input === "object" && input !== null && "op" in input && input.op === "close") close();
});
