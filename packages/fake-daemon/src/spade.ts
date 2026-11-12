import type { ClientMessage, ServerMessage, SpadeStatus } from "@ace/protocol";

type Push = (message: ServerMessage) => void;
type HttpRequest = Extract<ClientMessage, { type: "spade.http" }>;
type HttpResult = Extract<ServerMessage, { type: "spade.http.result" }>["result"];

/** One stored event as Spade's API writes it (`spade/docs/chat-core.md`). */
interface Stored {
  seq: number;
  at: number;
  event: Record<string, unknown> & { type: string };
}

interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
  events: Stored[];
  /** The open reply, while one runs. */
  answering: string | undefined;
  waitingOnYou: boolean;
}

/** `GET /v1/models` as a test stages it, in Spade's own shape (`needs_key`, `key_set`, …). */
export interface FakeSpadeModels {
  endpoints: {
    id: string;
    name?: string;
    needs_key?: boolean;
    key_set?: boolean;
    key_source?: string;
    models: { id: string; name?: string }[];
  }[];
  roles: Record<string, string>;
  keychain: boolean;
}

const conversationPath = /^\/v1\/conversations\/([^/?]+)(\/[^?]*)?(?:\?(.*))?$/;

/**
 * Spade as the daemon forwards it (ADR 0121): its status, and a small Spade behind `spade.http`
 * and `spade.live.*` that stores conversations in memory. Tests stage what Spade says next with
 * `store` and `delta`, as a model would; every request the phone makes is answered the way
 * Spade's API answers it. Keys a test saves land in `keys`, this fake's keychain.
 */
export class FakeSpade {
  status: SpadeStatus = { state: "off" };
  models: FakeSpadeModels = { endpoints: [], roles: {}, keychain: true };
  /** The keychain: endpoint id → key. */
  readonly keys = new Map<string, string>();
  /** Every `spade.http` the daemon received, without its body. */
  readonly asked: { method: string; path: string }[] = [];
  private readonly conversations = new Map<string, Conversation>();
  private readonly watchers = new Set<Push>();
  private readonly streams = new Map<string, { push: Push; conversation: string }>();
  private next = 1;
  private clock = 1_800_000_000_000;

  /** True when it answered `message`. */
  handle(message: ClientMessage, push: Push): boolean {
    switch (message.type) {
      case "spade.status":
        this.watchers.add(push);
        push({ type: "spade.status.result", requestId: message.requestId, status: this.status });
        return true;
      case "spade.http":
        this.asked.push({ method: message.method, path: message.path });
        push({
          type: "spade.http.result",
          requestId: message.requestId,
          result: this.http(message),
        });
        return true;
      case "spade.live.subscribe":
        this.subscribe(message.requestId, message.path, push);
        return true;
      case "spade.live.unsubscribe":
        if (this.streams.delete(message.requestId))
          push({ type: "spade.live.ended", requestId: message.requestId, reason: "unsubscribed" });
        return true;
      default:
        return false;
    }
  }

  /** A socket closed: its status watch and streams end with it. */
  release(push: Push): void {
    this.watchers.delete(push);
    for (const [id, stream] of this.streams) if (stream.push === push) this.streams.delete(id);
  }

  /** Spade's status changes; every socket that asked hears it. */
  setStatus(status: SpadeStatus): void {
    this.status = status;
    for (const push of this.watchers) push({ type: "spade.status.changed", status });
    if (status.state === "ready") return;
    // Spade stopped: the daemon ends its streams as restarted.
    for (const [requestId, stream] of this.streams)
      stream.push({ type: "spade.live.ended", requestId, reason: "restarted" });
    this.streams.clear();
  }

  /** A conversation already in Spade, named as Spade names one (`renamed`), with these events. */
  seed(id: string, title: string, events: Stored["event"][] = []): void {
    this.conversations.set(id, {
      id,
      title: "",
      updatedAt: (this.clock += 1000),
      events: [],
      answering: undefined,
      waitingOnYou: false,
    });
    if (title) this.store(id, { type: "renamed", title });
    for (const event of events) this.store(id, event);
  }

  /** Spade stores `event` in `id`; open streams receive it. */
  store(id: string, event: Stored["event"]): Stored {
    const conversation = this.conversation(id);
    const stored = { seq: this.next++, at: (this.clock += 1000), event };
    conversation.events.push(stored);
    conversation.updatedAt = stored.at;
    const reply = typeof event.reply === "string" ? event.reply : undefined;
    if (event.type === "reply_started") conversation.answering = reply;
    if (/^reply_(finished|stopped|failed|interrupted)$/.test(event.type))
      conversation.answering = undefined;
    if (event.type === "approval_requested") conversation.waitingOnYou = true;
    if (event.type === "approval_answered") conversation.waitingOnYou = false;
    if (event.type === "renamed" && typeof event.title === "string")
      conversation.title = event.title;
    this.frame(id, "stored", stored);
    return stored;
  }

  /** A live piece of the open reply's words, never stored. */
  delta(id: string, reply: string, text: string): void {
    this.frame(id, "delta", { reply, text });
  }

  /** Whether any live stream follows `id`. */
  following(id: string): boolean {
    return [...this.streams.values()].some((stream) => stream.conversation === id);
  }

  private conversation(id: string): Conversation {
    const conversation = this.conversations.get(id);
    if (!conversation) throw new Error(`No Spade conversation ${id}`);
    return conversation;
  }

  private frame(id: string, event: string, data: unknown) {
    for (const [requestId, stream] of this.streams)
      if (stream.conversation === id)
        stream.push({ type: "spade.live.frame", requestId, event, data: JSON.stringify(data) });
  }

  private subscribe(requestId: string, path: string, push: Push) {
    const ended = (reason: "unavailable" | "invalid_path" | "refused", status?: number) =>
      push({ type: "spade.live.ended", requestId, reason, ...(status ? { status } : {}) });
    if (this.status.state !== "ready") return ended("unavailable");
    const match = conversationPath.exec(path);
    if (!match || match[2] !== "/live") return ended("invalid_path");
    const id = decodeURIComponent(match[1] ?? "");
    const conversation = this.conversations.get(id);
    if (!conversation) return ended("refused", 404);
    const after = Number(new URLSearchParams(match[3] ?? "").get("after") ?? 0);
    this.streams.set(requestId, { push, conversation: id });
    for (const stored of conversation.events)
      if (stored.seq > after)
        push({
          type: "spade.live.frame",
          requestId,
          event: "stored",
          data: JSON.stringify(stored),
        });
    const seq = conversation.events.at(-1)?.seq ?? 0;
    push({
      type: "spade.live.frame",
      requestId,
      event: "caught_up",
      data: JSON.stringify({ seq }),
    });
  }

  private http(request: HttpRequest): HttpResult {
    if (this.status.state !== "ready")
      return { kind: "error", code: "unavailable", message: "Spade isn't running." };
    const body = parse(request.body);
    const { method, path } = request;
    if (method === "GET" && path === "/v1/conversations")
      return answer(
        200,
        [...this.conversations.values()]
          .toSorted((a, b) => b.updatedAt - a.updatedAt)
          .map((row) => ({
            id: row.id,
            title: row.title,
            updated_at: row.updatedAt,
            answering: row.answering !== undefined,
            jobs: 0,
            waiting_on_you: row.waitingOnYou,
          })),
      );
    if (method === "POST" && path === "/v1/conversations") {
      const text = typeof body?.text === "string" ? body.text : "";
      if (!text.trim()) return answer(400, { error: "A message needs words." });
      const id = `c${this.next}`;
      this.seed(id, "");
      this.store(id, { type: "user_message", text });
      return answer(201, { id });
    }
    if (method === "GET" && path === "/v1/models") return answer(200, this.models);
    const key = /^\/v1\/keys\/([^/?]+)$/.exec(path);
    if (key) return this.key(method, decodeURIComponent(key[1] ?? ""), body);
    const match = conversationPath.exec(path);
    const conversation = match && this.conversations.get(decodeURIComponent(match[1] ?? ""));
    if (!match || !conversation) return answer(404, { error: "No such conversation." });
    const rest = match[2] ?? "";
    if (method === "GET" && rest === "/events") {
      const query = new URLSearchParams(match[3] ?? "");
      const after = Number(query.get("after") ?? 0);
      const limit = Number(query.get("limit") ?? 200);
      return answer(
        200,
        conversation.events.filter((stored) => stored.seq > after).slice(0, limit),
      );
    }
    if (method === "POST" && rest === "/messages") {
      const text = typeof body?.text === "string" ? body.text : "";
      this.store(conversation.id, { type: "user_message", text });
      return answer(202, {});
    }
    if (method === "POST" && rest === "/stop") {
      if (!conversation.answering) return answer(404, { error: "Nothing to stop." });
      this.store(conversation.id, { type: "stop_requested", reply: conversation.answering });
      return answer(200, {});
    }
    const approval = /^\/approvals\/([^/]+)$/.exec(rest);
    if (method === "POST" && approval) {
      this.store(conversation.id, {
        type: "approval_answered",
        reply: conversation.answering ?? "",
        call_id: decodeURIComponent(approval[1] ?? ""),
        allowed: body?.allowed === true,
        always: body?.always === true,
      });
      return answer(200, {});
    }
    return answer(404, { error: "No such route." });
  }

  private key(method: string, endpoint: string, body: Record<string, unknown> | undefined) {
    const known = this.models.endpoints.find((entry) => entry.id === endpoint);
    if (!known) return answer(404, { error: "No such endpoint." });
    if (!this.models.keychain) return answer(409, { error: "This machine has no keychain." });
    if (method === "PUT" && typeof body?.key === "string" && body.key) {
      this.keys.set(endpoint, body.key);
      known.key_set = true;
      known.key_source = "keychain";
      return answer(204);
    }
    if (method === "DELETE") {
      this.keys.delete(endpoint);
      known.key_set = false;
      delete known.key_source;
      return answer(204);
    }
    return answer(400, { error: "A key is needed." });
  }
}

function answer(status: number, value?: unknown): HttpResult {
  return {
    kind: "response",
    status,
    body: value === undefined ? "" : JSON.stringify(value),
    encoding: "text",
    contentType: "application/json",
  };
}

function parse(body: string | undefined): Record<string, unknown> | undefined {
  if (!body) return undefined;
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
