/**
 * The app's shutdown before it quits: everything that must reach the daemon before it stops
 * (taking back the update report, telling it the browser backend is going) runs at once, and
 * the daemon this app started stops only after all of it has finished or failed. A failed
 * step never keeps the daemon running; its error is raised once the daemon has stopped.
 */
export async function shutDownBeforeQuit(steps: {
  beforeDaemon: readonly (() => Promise<void>)[];
  daemon: () => Promise<void>;
}): Promise<void> {
  const before = await Promise.allSettled(steps.beforeDaemon.map((step) => step()));
  await steps.daemon();
  const failed = before.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
