import { ClientError } from "@ace/client";
import type { App } from "./app-context.ts";
import { openLive } from "./live.ts";

/**
 * Reaching the daemon for the interactive shell (ADR 0176 §9): whether it runs, starting it
 * when asked, and opening the connection and the live stores the views read.
 */
export function isOffline(error: unknown): boolean {
  if (error instanceof ClientError) return error.code === "offline" || error.code === "timeout";
  return (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ECONNREFUSED"].includes(String(error.code))
  );
}

/** Whether the local daemon answers its status, quickly; false when it isn't running. */
export async function daemonUp(home: string): Promise<boolean> {
  const { hostConnection } = await import("../connection.ts");
  const { accessRequest } = await import("../../client-access.ts");
  try {
    const connection = hostConnection(home);
    await Promise.race([
      accessRequest(connection.origin, "/v1/status", { token: connection.token }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new ClientError("timeout")), 1500).unref(),
      ),
    ]);
    return true;
  } catch (error) {
    if (isOffline(error)) return false;
    return true;
  }
}

/** Starts the local daemon detached, as `ace chat` does. */
export async function startDaemon(app: App): Promise<void> {
  app.terminal.draw({ lines: [app.ink.dim("Starting ace…")] });
  const { ensureDaemon, systemOpenRuntime } = await import("../open-runtime.ts");
  await ensureDaemon(app.start.dataDir, app.start.args, systemOpenRuntime());
}

/** Connects and opens the live stores; false when the daemon isn't running and may not start. */
export async function connect(app: App): Promise<boolean> {
  const { connectChat } = await import("../connection.ts");
  const { start } = app;
  if (!start.args.flags.remote && !(await daemonUp(start.dataDir))) {
    if (!start.startDaemon) return false;
    await startDaemon(app);
  }
  const session = await connectChat(start.dataDir, start.args);
  app.session = session;
  app.live = openLive(session.client, session.signal, app.schedule);
  session.signal.addEventListener("abort", () => app.quit("The connection to ace closed.", 1), {
    once: true,
  });
  return true;
}
