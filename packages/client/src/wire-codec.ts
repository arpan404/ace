import {
  CoreClientMessage,
  CoreServerMessage,
  coreClientTypes,
  coreServerTypes,
  type ClientMessage,
  type ServerMessage,
} from "@ace/protocol";

/*
 * Decoding and encoding wire messages (ADR 0056). The core stream (hello, subscriptions,
 * snapshots, events, commands, item pages, output reads) is decoded with schemas loaded with
 * the client; the service families load on demand, so the client worker starts with a fraction
 * of the protocol's schemas. Every message is still parsed with its full schema before use.
 */

export type ServiceWire = typeof import("./service-wire.ts");

/**
 * The service schemas, loading them the first time. The one place they are imported, so every
 * caller (a client's codec, the worker decoding a tab's service reads) shares one chunk.
 */
export const loadServiceWire = (): Promise<ServiceWire> => import("./service-wire.ts");

const typeOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
    ? value.type
    : undefined;

export class WireCodec {
  #service: ServiceWire | undefined;
  #loading: Promise<ServiceWire> | undefined;
  /** The service schemas, loading them the first time. */
  load(): Promise<ServiceWire> {
    this.#loading ??= loadServiceWire().then((module) => (this.#service = module));
    return this.#loading;
  }
  /** The service schemas if they have loaded. */
  get loaded(): ServiceWire | undefined {
    return this.#service;
  }
  /**
   * A server frame, parsed. Undefined only for a service message that arrived before the
   * service schemas loaded: the caller holds it (and what follows) until `load()` settles.
   */
  decode(value: unknown): ServerMessage | undefined {
    const type = typeOf(value);
    if (type !== undefined && coreServerTypes.has(type)) return CoreServerMessage.parse(value);
    return this.#service?.ServerMessage.parse(value);
  }
  /** A client message, parsed; undefined for a service message before its schemas loaded. */
  encode(value: unknown): ClientMessage | undefined {
    const type = typeOf(value);
    if (type !== undefined && coreClientTypes.has(type)) return CoreClientMessage.parse(value);
    return this.#service?.ClientMessage.parse(value);
  }
}
