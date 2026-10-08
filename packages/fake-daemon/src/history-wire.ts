import {
  ThreadId,
  type ClientMessage,
  type ServerMessage,
  type HistorySession,
} from "@ace/protocol";
import type { FakeServiceContext } from "./service-context.ts";

/** Fixture-only history, using the same import/continue wire operations as local history. */
export class FakeHistory {
  private sessions: HistorySession[] = [];
  private imported = new Map<string, ThreadId>();
  private host: FakeServiceContext;
  constructor(host: FakeServiceContext) {
    this.host = host;
  }
  seed(sessions: HistorySession[]) {
    this.sessions = sessions;
  }
  handle(message: ClientMessage, send: (message: ServerMessage) => void): boolean {
    const scan = {
      state: "ready" as const,
      stats: { files: this.sessions.length, reads: 0, bytes: 0, skipped: this.sessions.length },
      unsupported: [],
    };
    if (message.type === "history.list") {
      const sessions = this.sessions
        .filter((session) => session.cwd === message.cwd)
        .toSorted((a, b) => b.lastActivity - a.lastActivity || b.id.localeCompare(a.id))
        .filter(
          (session) =>
            !message.before ||
            session.lastActivity < message.before.lastActivity ||
            (session.lastActivity === message.before.lastActivity &&
              session.id < message.before.id),
        );
      const page = sessions.slice(0, message.limit);
      const last = page.at(-1);
      send({
        type: "history.list",
        requestId: message.requestId,
        scan,
        sessions: page,
        next:
          sessions.length > page.length && last
            ? { id: last.id, lastActivity: last.lastActivity }
            : null,
      });
      return true;
    }
    if (message.type === "history.scan") {
      send({
        type: "history.scan",
        requestId: message.requestId,
        scan,
        files: scan.stats.files,
        unsupported: [],
      });
      return true;
    }
    if (message.type === "history.import") {
      const session = this.sessions.find((entry) => entry.id === message.sourceId);
      if (!session || session.support.status !== "supported") {
        send({
          type: "history.import",
          requestId: message.requestId,
          status: "unsupported",
          reason: "History format unavailable",
        });
        return true;
      }
      let id = this.imported.get(session.id);
      if (!id) {
        id = ThreadId.parse(`past-${session.id}`);
        this.host.createThread?.({
          id,
          workspaceId: message.workspaceId,
          title: session.title,
          provider: session.provider,
          imported: {
            sourceId: session.id,
            instanceId: session.instanceId,
            importedAt: this.host.now(),
            native: { provider: session.provider, nativeId: session.nativeId },
          },
        });
        this.imported.set(session.id, id);
        this.host.apply?.(id, [
          {
            type: "item.upsert",
            agent: "root",
            item: "saved-message",
            draft: {
              type: "message",
              role: "user",
              parts: [{ type: "text", text: session.title }],
              complete: true,
            },
          },
        ]);
      }
      send({
        type: "history.import",
        requestId: message.requestId,
        status: "imported",
        threadId: id,
      });
      return true;
    }
    if (message.type === "history.continue") {
      const session = this.sessions.find(
        (entry) => this.imported.get(entry.id) === message.threadId,
      );
      if (!session || session.continuation?.status !== "supported")
        send({
          type: "history.continue",
          requestId: message.requestId,
          status: "unsupported",
          reason: "Native resume unavailable",
        });
      else
        send({
          type: "history.continue",
          requestId: message.requestId,
          status: "continued",
          threadId: message.threadId,
          nativeSessionId: session.nativeId,
          instanceId: session.instanceId,
        });
      return true;
    }
    return false;
  }
}
