import {
  ThreadId,
  type ClientMessage,
  type ServerMessage,
  type HistorySession,
} from "@ace/protocol";
import { rootAgent, message as transcriptMessage } from "./scenarios/facts.ts";
import type { FakeServiceContext } from "./service-context.ts";

/** Fixture-only history, using the same import/continue wire operations as local history. */
export class FakeHistory {
  private sessions: HistorySession[] = [];
  private transcripts: Record<string, { role: "user" | "assistant"; text: string; at?: number }[]> =
    {};
  private imported = new Map<string, ThreadId>();
  private scan: import("@ace/protocol").HistoryScanStatus | undefined;
  seedScan(scan: import("@ace/protocol").HistoryScanStatus): void {
    this.scan = scan;
  }
  private host: FakeServiceContext;
  constructor(host: FakeServiceContext) {
    this.host = host;
  }
  seed(sessions: HistorySession[], transcripts = this.transcripts) {
    this.sessions = sessions;
    this.transcripts = transcripts;
  }
  handle(message: ClientMessage, send: (message: ServerMessage) => void): boolean {
    const scan = this.scan ?? {
      state: "ready" as const,
      stats: { files: this.sessions.length, reads: 0, bytes: 0, skipped: this.sessions.length },
      unsupported: [],
    };
    if (message.type === "history.list") {
      const sessions = this.sessions
        .filter(
          (session) =>
            session.cwd === message.cwd &&
            !session.parentNativeId &&
            (!message.openableOnly || session.support.status === "supported") &&
            (!message.search || session.title.toLowerCase().includes(message.search.toLowerCase())),
        )
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
    const progress = (phase: "preparing" | "unsupported" | "completed") => {
      if (
        (message.type === "history.import" || message.type === "history.continue") &&
        message.requestId
      )
        send({
          type: "history.operation.progress",
          requestId: message.requestId,
          operation: message.type,
          phase,
        });
    };
    if (message.type === "history.import") {
      progress("preparing");
      const session = this.sessions.find((entry) => entry.id === message.sourceId);
      if (
        !session ||
        session.support.status !== "supported" ||
        !this.transcripts[session.id]?.length
      ) {
        progress("unsupported");
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
        const root = rootAgent(session.provider, session.cwd);
        if (root.type === "agent.seen") root.native.nativeId = session.nativeId;
        const transcript = this.transcripts[session.id] ?? [];
        this.host.apply?.(id, [root], transcript[0]?.at ?? session.lastActivity);
        const importedId = id;
        transcript.forEach((entry, index) =>
          this.host.apply?.(
            importedId,
            [transcriptMessage("root", `saved-${index}`, entry.role, entry.text)],
            entry.at ?? session.lastActivity,
          ),
        );
        const view = this.host.thread(id);
        if (view?.thread.rootAgentId)
          this.host.update(id, {
            type: "agent.status",
            agentId: view.thread.rootAgentId,
            status: { state: "idle" },
          });
        this.host.update(id, { type: "thread.updated", status: { state: "done" } });
        this.host.update(id, {
          type: "thread.client.updated",
          changes: {
            settledAt: this.host.now(),
            settledReason: "manual",
            unread: false,
            readAt: this.host.now(),
          },
        });
      }
      progress("completed");
      send({
        type: "history.import",
        requestId: message.requestId,
        status: "imported",
        threadId: id,
      });
      return true;
    }
    if (message.type === "history.continue") {
      progress("preparing");
      const session = this.sessions.find(
        (entry) => this.imported.get(entry.id) === message.threadId,
      );
      const supported = session?.continuation?.status === "supported";
      progress(supported ? "completed" : "unsupported");
      if (!supported)
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
