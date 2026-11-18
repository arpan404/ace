/** One step of the shutdown, named for the log. */
export interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
}

/**
 * The app's shutdown before it quits: everything that must reach the daemon before it stops
 * (taking back the update report, telling it the browser backend is going) runs at once, and
 * the daemon this app started stops only after all of it has finished or failed. A failed
 * step never keeps the daemon running; its error is raised once the daemon has stopped. Each
 * step's time is logged, so a slow quit or update restart says where the time went.
 */
export async function shutDownBeforeQuit(steps: {
  beforeDaemon: readonly ShutdownStep[];
  daemon: () => Promise<void>;
  now: () => number;
  log: (message: string, data: Record<string, unknown>) => void;
}): Promise<void> {
  const timed = async (step: ShutdownStep) => {
    const started = steps.now();
    try {
      await step.run();
    } finally {
      steps.log(`Before quit: ${step.name}`, { ms: steps.now() - started });
    }
  };
  const before = await Promise.allSettled(steps.beforeDaemon.map(timed));
  await steps.daemon();
  const failed = before.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}
