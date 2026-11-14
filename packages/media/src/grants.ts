import type { FromMedia, ToMedia } from "./wire.ts";

/**
 * Which grants a revocation covers, and the in-flight work one ace-media process holds
 * (docs/media/plan.md, "Revocation deadline" and "Effects of a restart"). Pure.
 */

type Message<T extends ToMedia["type"]> = Extract<ToMedia, { type: T }>;
type Admission = Message<"media.ticket">["owner"]["admission"];
export type Revocation = Message<"revoke"> | Message<"connection.close"> | Message<"relay.close">;
/** How a revocation ended: ace-media answered, or the process (and so every socket) is gone. */
export type RevocationResult = "answered" | "killed" | "not-running";
export type GrantRule = (message: ToMedia) => boolean;

const grantTypes = new Set<ToMedia["type"]>(["media.ticket", "viewer.open", "relay.keys"]);

export function isRevocation(message: ToMedia): message is Revocation {
  return (
    message.type === "revoke" ||
    message.type === "connection.close" ||
    message.type === "relay.close"
  );
}

/**
 * The grants a revocation covers: for `revoke`, the device's (one admission, or every admission
 * when none is named) issued no later than it; for `connection.close`, the connection's; for
 * `relay.close`, the stream's keys.
 */
export function revocationRule(revocation: Revocation): GrantRule {
  return (message) => {
    if (!grantTypes.has(message.type)) return false;
    if (revocation.type === "connection.close")
      return "connection" in message && message.connection === revocation.connection;
    if (revocation.type === "relay.close")
      return message.type === "relay.keys" && message.stream === revocation.stream;
    if (!("owner" in message) || !("issued" in message)) return false;
    return (
      message.owner.device === revocation.device &&
      message.issued <= revocation.issued &&
      (!revocation.admission || sameAdmission(message.owner.admission, revocation.admission))
    );
  };
}

function sameAdmission(a: Admission, b: Admission): boolean {
  if (a.kind === "pairing" && b.kind === "pairing") return a.generation === b.generation;
  if (a.kind === "account" && b.kind === "account") return a.account === b.account;
  return false;
}

export type InFlightWork = {
  stills: string[];
  connections: string[];
  sources: string[];
  recordings: string[];
};

/**
 * What one process holds: open sources, recordings until their terminal reply (a `record.stop`
 * still awaits `record.done` or `record.failed`), stills awaiting an answer, and connections
 * from their ticket until `connection.closed`.
 */
export class InFlight {
  readonly #stills = new Set<string>();
  readonly #connections = new Set<string>();
  readonly #sources = new Set<string>();
  readonly #recordings = new Set<string>();

  sent(message: ToMedia): void {
    switch (message.type) {
      case "source.open":
        return void this.#sources.add(message.source);
      case "source.close":
        return void this.#sources.delete(message.source);
      case "record.start":
        return void this.#recordings.add(message.recording);
      case "still.take":
        return void this.#stills.add(message.request);
      case "media.ticket":
        return void this.#connections.add(message.connection);
    }
  }

  received(message: FromMedia): void {
    switch (message.type) {
      case "still.done":
      case "still.failed":
        return void this.#stills.delete(message.request);
      case "record.done":
      case "record.failed":
        return void this.#recordings.delete(message.recording);
      case "connection.open":
        return void this.#connections.add(message.connection);
      case "connection.closed":
        return void this.#connections.delete(message.connection);
    }
  }

  list(): InFlightWork {
    return {
      stills: [...this.#stills],
      connections: [...this.#connections],
      sources: [...this.#sources],
      recordings: [...this.#recordings],
    };
  }
}
