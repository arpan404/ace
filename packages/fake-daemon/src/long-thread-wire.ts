import { mergeTurnDigests, turnActivityStatus } from "@ace/projection";
import { threadItemText } from "@ace/search/thread-text";
import type {
  ClientMessage,
  CommandResult,
  ServerMessage,
  ThreadView,
  Item,
  ThreadMarkReadCommand,
  CommandId,
  DeviceId,
} from "@ace/protocol";
import type { ThreadHost } from "./thread-host.ts";
import { FakeTurnIndex } from "./long-thread-index.ts";

interface LongThreadHost {
  head(): number;
  thread(id: string): ThreadHost | undefined;
  output(id: string): string;
  now(): number;
}

/** Request owner shared by fake connections; read cursors survive their reconnects. */
export class FakeLongThreadWire {
  readonly index = new FakeTurnIndex();
  private reads = new Map<string, { lastSeenSeq: number; updatedAt: number }>();
  constructor(privateHost: LongThreadHost) {
    this.host = privateHost;
  }
  private host: LongThreadHost;

  markRead(
    commandId: CommandId,
    payload: ThreadMarkReadCommand,
    deviceId: DeviceId,
    at = this.host.now(),
  ): CommandResult {
    const host = this.visible(payload.threadId);
    if (!host) return { commandId, ok: false, error: "thread_not_found" };
    const key = JSON.stringify([deviceId, payload.threadId]);
    const previous = this.reads.get(key);
    const lastSeenSeq = Math.min(payload.lastSeenSeq, this.host.head());
    if (lastSeenSeq > (previous?.lastSeenSeq ?? 0))
      this.reads.set(key, { lastSeenSeq, updatedAt: at });
    return { commandId, ok: true };
  }

  private visible(id: string): ThreadHost | undefined {
    const host = this.host.thread(id);
    return host?.view.thread.deletedAt === undefined ? host : undefined;
  }

  handle(
    message: ClientMessage,
    deviceId: string,
    send: (message: ServerMessage) => void,
  ): boolean {
    if (
      ![
        "turns.page",
        "items.window",
        "thread.search",
        "thread.catchUp",
        "thread.readState",
      ].includes(message.type)
    )
      return false;
    if (!("threadId" in message) || !message.threadId || !("requestId" in message)) return false;
    const host = this.visible(message.threadId);
    if (!host) {
      send({
        type: "error",
        requestId: message.requestId,
        code: "thread_not_found",
        message: "thread_not_found",
      });
      return true;
    }
    const seq = this.host.head();
    const turns =
      message.type === "turns.page" || message.type === "items.window"
        ? this.index.summaries(message.threadId)
        : [];
    switch (message.type) {
      case "turns.page": {
        const selected = turns.filter(
          (turn) =>
            (message.before === undefined || turn.ordinal < message.before) &&
            (message.after === undefined || turn.ordinal > message.after),
        );
        const page =
          message.after === undefined
            ? selected.slice(-message.limit)
            : selected.slice(0, message.limit);
        const first = page[0]?.ordinal;
        const last = page.at(-1)?.ordinal;
        send({
          type: message.type,
          requestId: message.requestId,
          threadId: message.threadId,
          seq,
          indexedSeq: seq,
          ready: true,
          turns: structuredClone(page),
          before: first !== undefined && turns.some((turn) => turn.ordinal < first) ? first : null,
          after: last !== undefined && turns.some((turn) => turn.ordinal > last) ? last : null,
        });
        return true;
      }
      case "items.window": {
        const target =
          message.aroundSeq ?? turns.find((turn) => turn.ordinal === message.turnOrdinal)?.startSeq;
        if (target === undefined) {
          send({
            type: "error",
            requestId: message.requestId,
            code: "turn_not_found",
            message: "turn_not_found",
          });
          return true;
        }
        const order = host.view.itemOrder;
        let targetIndex = order.findIndex((id) => (host.creation.get(id) ?? 0) >= target);
        if (targetIndex < 0) targetIndex = order.length - 1;
        const ids = order.slice(
          Math.max(0, targetIndex - message.before),
          targetIndex + message.after + 1,
        );
        const items = ids.flatMap((id) =>
          host.view.items[id] ? [structuredClone(host.view.items[id])] : [],
        );
        send({
          type: message.type,
          requestId: message.requestId,
          threadId: message.threadId,
          seq,
          targetSeq:
            order[targetIndex] === undefined
              ? null
              : (host.creation.get(order[targetIndex] ?? "") ?? null),
          items,
          itemSeqs: Object.fromEntries(
            ids.flatMap((id) => {
              const value = host.creation.get(id);
              return value === undefined ? [] : [[id, value]];
            }),
          ),
          itemsBefore: ids[0] !== order[0] ? (host.creation.get(ids[0] ?? "") ?? null) : null,
          itemsAfter:
            ids.at(-1) !== order.at(-1) ? (host.creation.get(ids.at(-1) ?? "") ?? null) : null,
        });
        return true;
      }
      case "thread.catchUp": {
        const family = this.tree(host.view);
        if (!family) {
          send({
            type: "error",
            requestId: message.requestId,
            code: "family_too_large",
            message: "family_too_large",
          });
          return true;
        }
        const latest = family
          .map((source) => this.index.latestMessage(source.id))
          .filter((value) => value !== undefined)
          .toSorted((a, b) => b.seq - a.seq)[0];
        const index = this.index;
        const since = { sinceSeq: message.sinceSeq, sinceTime: message.sinceTime };
        const statuses = family.map(
          (source) => index.currentStatus(source.id) ?? source.view.thread.status,
        );
        function* digests() {
          for (const source of family ?? []) yield index.rangeDigest(source.id, since);
        }
        const digest = mergeTurnDigests(digests());
        send({
          type: message.type,
          requestId: message.requestId,
          threadId: message.threadId,
          seq,
          indexedSeq: seq,
          ready: true,
          turnsCompleted: this.index.completed(message.threadId, message),
          status: structuredClone(
            turnActivityStatus(
              {
                "live:interactions": digest.approvalsPending,
                "live:agents": family.filter(
                  (source) =>
                    !["done", "new", "failed"].includes(
                      (index.currentStatus(source.id) ?? source.view.thread.status).state,
                    ),
                ).length,
              },
              statuses,
            ) ??
              (statuses.some((status) => status.state === "failed")
                ? { state: "failed" }
                : host.view.thread.status),
          ),
          digest,
          latestAgentMessagePreview: latest?.preview ?? "",
        });
        return true;
      }
      case "thread.readState": {
        const state = this.reads.get(JSON.stringify([deviceId, message.threadId]));
        send({
          type: message.type,
          requestId: message.requestId,
          threadId: message.threadId,
          lastSeenSeq: state?.lastSeenSeq ?? 0,
          updatedAt: state?.updatedAt ?? null,
        });
        return true;
      }
      case "thread.search": {
        const signature = queryFingerprint([
          message.threadId,
          message.text,
          message.scope,
          message.filter ?? null,
        ]);
        const split = message.cursor?.indexOf(":") ?? -1;
        const afterSeq = message.cursor === undefined ? 0 : Number(message.cursor.slice(0, split));
        if (
          message.cursor !== undefined &&
          (split < 0 ||
            message.cursor.slice(split + 1) !== signature ||
            !Number.isSafeInteger(afterSeq) ||
            afterSeq < 0)
        ) {
          send({
            type: "error",
            requestId: message.requestId,
            code: "invalid_cursor",
            message: "invalid_cursor",
          });
          return true;
        }
        const sources = message.scope === "tree" ? this.tree(host.view) : [host];
        if (!sources) {
          send({
            type: "error",
            requestId: message.requestId,
            code: "family_too_large",
            message: "family_too_large",
          });
          return true;
        }
        const matches: import("@ace/protocol").ThreadSearchResponse["hits"] = [];
        for (const source of sources)
          for (const id of source.view.itemOrder) {
            const item = source.view.items[id];
            const creation = source.creation.get(id);
            if (!item || creation === undefined || creation <= afterSeq) continue;
            const text = searchableText(item, message.filter, this.host.output, message.text);
            const matchAt = text.toLocaleLowerCase().indexOf(message.text.toLocaleLowerCase());
            if (matchAt < 0) continue;
            const start = Math.max(0, matchAt - 96);
            const snippet = text.slice(start, start + 320);
            matches.push({
              threadId: source.view.thread.id,
              itemId: item.id,
              seq: creation,
              turnOrdinal: this.index.itemTurn(item.id),
              snippet: {
                text: snippet,
                highlights: [
                  {
                    start: matchAt - start,
                    end: Math.min(snippet.length, matchAt - start + message.text.length),
                  },
                ],
              },
            });
            matches.toSorted((left, right) => left.seq - right.seq);
            if (matches.length > message.limit + 1) matches.pop();
          }
        const hits = matches.slice(0, message.limit);
        send({
          type: message.type,
          requestId: message.requestId,
          threadId: message.threadId,
          hits,
          cursor: matches.length > hits.length ? `${hits.at(-1)?.seq ?? 0}:${signature}` : null,
          indexedSeq: seq,
          headSeq: seq,
          pending: 0,
          ready: true,
        });
        return true;
      }
      default:
        return false;
    }
  }

  private tree(view: ThreadView): ThreadHost[] | undefined {
    const result: ThreadHost[] = [];
    const seen = new Set<string>();
    const pending = [view.thread.id];
    while (pending.length) {
      const id = pending.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      if (seen.size > 512) return undefined;
      const host = this.visible(id);
      if (!host) continue;
      result.push(host);
      for (const agent of Object.values(host.view.agents))
        if (agent.childThreadId) pending.push(agent.childThreadId);
    }
    return result;
  }
}

function searchableText(
  item: Item,
  filter: "messages" | "tool_output" | "commands" | "files" | "errors" | undefined,
  output: (id: string) => string,
  query: string,
): string {
  const text: string[] = [];
  for (const segment of threadItemText(item)) {
    if (filter !== undefined && segment.category !== filter) continue;
    text.push(segment.source ? output(segment.source.streamId) || segment.text : segment.text);
  }
  return (
    text.find((field) => field.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ??
    text.join("\n")
  );
}

// A bounded deterministic cursor binding for fake mode, including non-ASCII queries.
function queryFingerprint(fields: readonly (string | null)[]): string {
  const text = JSON.stringify(fields);
  let first = 2166136261,
    second = 2246822519;
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 16777619) >>> 0;
    second = Math.imul(second ^ text.charCodeAt(index), 3266489917) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}
