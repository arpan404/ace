import type { Client } from "@ace/client";
import type { RefReader, RefSource } from "./completion-live.ts";

/**
 * This machine's daemon as completion's reference source (ADR 0176 §6). Reaching it reads the
 * endpoint file and probes the port, and only when something listens loads the client; each read
 * then opens a read-only connection, asks one question and closes. It never starts the daemon,
 * never prompts and never writes.
 */
export function daemonRefs(home: () => string): RefSource {
  return {
    async reach() {
      const dir = home();
      const { reachLocalDaemon } = await import("./daemon-endpoint.ts");
      const connection = await reachLocalDaemon(dir);
      const [{ peekLocalDaemon }, reads] = await Promise.all([
        import("./connection.ts"),
        import("./work/daemon.ts"),
      ]);
      const peek = async <T>(
        signal: AbortSignal,
        read: (client: Client) => Promise<T>,
      ): Promise<T> => {
        const session = await peekLocalDaemon(dir, connection, signal);
        try {
          return await read(session.client);
        } finally {
          await session.close();
        }
      };
      const reader: RefReader = {
        threads: (signal) =>
          peek(signal, async (client) => {
            // The list's first page: the threads the app shows first.
            const list = await reads.readThreadList(client, signal, { want: 1 });
            return list.entries.map((entry) => ({ id: entry.id, title: entry.title }));
          }),
        projects: (signal) =>
          peek(signal, async (client) =>
            (await reads.readProjects(client, signal)).map(({ id, name, path }) => ({
              id,
              name,
              path,
            })),
          ),
        requests: (signal) =>
          peek(signal, async (client) =>
            (await reads.readRequests(client, signal)).requests.map((open) => ({
              id: open.interaction.id,
              kind: open.interaction.request.kind,
              threadTitle: open.threadTitle,
            })),
          ),
        bots: (signal) =>
          peek(signal, async (client) => {
            const [{ spadeCaller }, { listBots }] = await Promise.all([
              import("./spade-call.ts"),
              import("./spade-bots.ts"),
            ]);
            const bots = await listBots(await spadeCaller(client, signal));
            return bots.map(({ id, name, task }) => ({ id, name, task }));
          }),
      };
      return reader;
    },
  };
}
