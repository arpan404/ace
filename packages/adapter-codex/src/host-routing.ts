import type { RpcId } from "@ace/provider-kit/jsonrpc";
import { list, obj, str } from "./native.ts";
import { parentOf } from "./session-state.ts";
import { RecentSet } from "./retention.ts";

const opening = new Set(["thread/start", "thread/resume", "thread/fork"]);
const requestLimit = 4096;
const servedLimit = 1024;

/** Where one received app-server message belongs. */
export type Route<T> =
  | { to: "tenant"; tenant: T; claimed: readonly string[] }
  | { to: "host" }
  | { to: "all" }
  | { to: "hold"; thread: string }
  | { to: "drop" };

/** Thread id a message is about, including `thread/started`, which nests it. */
export function subjectThread(message: Record<string, unknown>): string {
  const params = obj(message["params"]);
  return str(params["threadId"], str(obj(params["thread"])["id"]));
}

/** Child threads a routed frame reveals. Their later events belong to the same owner. */
export function revealedChildren(message: Record<string, unknown>): string[] {
  const method = str(message["method"]);
  if (method !== "item/started" && method !== "item/completed") return [];
  const item = obj(obj(message["params"])["item"]);
  if (item["type"] === "collabAgentToolCall" && item["tool"] === "spawnAgent")
    return list(item["receiverThreadIds"])
      .map((id) => str(id))
      .filter(Boolean);
  if (item["type"] === "subAgentActivity" && item["kind"] === "started") {
    const child = str(item["agentThreadId"]);
    return child ? [child] : [];
  }
  return [];
}

/**
 * Pure ownership bookkeeping for one app-server shared by several ace threads. A tenant owns the
 * native threads it opened and every descendant they reveal. Responses follow the request that
 * asked; nothing unowned is guessed onto a tenant.
 */
export class HostRouter<T> {
  readonly #owners = new Map<string, T>();
  readonly #requests = new Map<RpcId, { tenant: T | undefined; method: string }>();
  readonly #served = new Map<RpcId, T>();
  readonly #released = new RecentSet();
  /** Requests may name only their turn; a turn belongs to its thread's owner. */
  readonly #turns = new Map<string, T>();
  #opening = 0;

  /** Open requests in flight. While any is pending, an unowned root may still be claimed. */
  get opening(): number {
    return this.#opening;
  }
  owner(thread: string): T | undefined {
    return this.#owners.get(thread);
  }
  /** Released by a detached tenant; its late events are not evidence of a new owner. */
  released(thread: string): boolean {
    return this.#released.has(thread);
  }
  claim(thread: string, tenant: T): boolean {
    if (!thread || this.#owners.get(thread) === tenant) return false;
    this.#owners.set(thread, tenant);
    this.#released.delete(thread);
    return true;
  }
  /** Forget a tenant. Returns the threads it owned so the host can unsubscribe them. */
  release(tenant: T): string[] {
    const threads: string[] = [];
    for (const [thread, owner] of this.#owners)
      if (owner === tenant) {
        threads.push(thread);
        this.#owners.delete(thread);
        this.#released.add(thread);
      }
    for (const [id, request] of this.#requests) if (request.tenant === tenant) this.#forget(id);
    for (const [id, owner] of this.#served) if (owner === tenant) this.#served.delete(id);
    for (const [turn, owner] of this.#turns) if (owner === tenant) this.#turns.delete(turn);
    return threads;
  }
  /** A server request routed to a tenant; its answer is that tenant's frame. */
  serve(id: RpcId, tenant: T): void {
    if (this.#served.size >= servedLimit) {
      const oldest = this.#served.keys().next().value;
      if (oldest !== undefined) this.#served.delete(oldest);
    }
    this.#served.set(id, tenant);
  }
  /** Attribute an outgoing frame. `sender` is undefined for the host's own traffic. */
  sent(message: Record<string, unknown>, sender: T | undefined): T | undefined {
    const id = message["id"];
    const method = message["method"];
    if (typeof method !== "string") {
      if (typeof id !== "string" && typeof id !== "number") return undefined;
      const tenant = this.#served.get(id);
      this.#served.delete(id);
      return tenant;
    }
    if (typeof id === "string" || typeof id === "number") {
      if (this.#requests.size >= requestLimit) {
        const oldest = this.#requests.keys().next().value;
        if (oldest !== undefined) this.#forget(oldest);
      }
      this.#requests.set(id, { tenant: sender, method });
      if (sender !== undefined && opening.has(method)) this.#opening++;
    }
    return sender;
  }
  received(message: Record<string, unknown>): Route<T> {
    const id = message["id"];
    const method = message["method"];
    if (typeof method !== "string") {
      if (typeof id !== "string" && typeof id !== "number") return { to: "drop" };
      const request = this.#requests.get(id);
      if (!request) return { to: "drop" };
      this.#forget(id);
      if (request.tenant === undefined) return { to: "host" };
      const claimed: string[] = [];
      if (opening.has(request.method) && message["error"] === undefined) {
        const thread = str(obj(obj(message["result"])["thread"])["id"]);
        if (this.claim(thread, request.tenant)) claimed.push(thread);
      }
      return { to: "tenant", tenant: request.tenant, claimed };
    }
    const thread = subjectThread(message);
    if (!thread) {
      const turnOwner = this.#turns.get(str(obj(message["params"])["turnId"]));
      if (turnOwner !== undefined) return { to: "tenant", tenant: turnOwner, claimed: [] };
      return typeof id === "string" || typeof id === "number" ? { to: "host" } : { to: "all" };
    }
    let tenant = this.#owners.get(thread);
    const claimed: string[] = [];
    if (tenant === undefined && method === "thread/started") {
      const parent = parentOf(obj(obj(message["params"])["thread"]));
      const owner = parent ? this.#owners.get(parent) : undefined;
      if (owner !== undefined && this.claim(thread, owner)) {
        tenant = owner;
        claimed.push(thread);
      }
    }
    if (tenant === undefined) {
      // Codex broadcasts names for unloaded threads too; a name never proves ownership.
      if (method === "thread/name/updated" || this.#released.has(thread)) return { to: "drop" };
      return { to: "hold", thread };
    }
    for (const child of revealedChildren(message))
      if (this.claim(child, tenant)) claimed.push(child);
    this.#trackTurn(method, message, tenant);
    return { to: "tenant", tenant, claimed };
  }
  #trackTurn(method: string, message: Record<string, unknown>, tenant: T): void {
    const turn = str(obj(obj(message["params"])["turn"])["id"]);
    if (!turn) return;
    if (method === "turn/completed") this.#turns.delete(turn);
    else if (method === "turn/started") {
      if (this.#turns.size >= servedLimit) {
        const oldest = this.#turns.keys().next().value;
        if (oldest !== undefined) this.#turns.delete(oldest);
      }
      this.#turns.set(turn, tenant);
    }
  }
  #forget(id: RpcId): void {
    const request = this.#requests.get(id);
    if (!request) return;
    this.#requests.delete(id);
    if (request.tenant !== undefined && opening.has(request.method)) this.#opening--;
  }
}
