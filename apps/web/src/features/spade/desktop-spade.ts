import type { SpadeLiveEndReason, SpadeMethod } from "@ace/protocol";

/*
 * The desktop app's direct path to Spade (`window.ace.spade`, ADR 0123). The main process holds
 * Spade's address and token and makes each request on loopback; the page never sees the token.
 * Everything the bridge returns is read leniently here: anything unexpected is a failure, never
 * a crash. Undefined in a browser or an older desktop build.
 */

export type DirectAnswer =
  | { kind: "text"; status: number; contentType: string | undefined; body: string }
  | { kind: "bytes"; status: number; contentType: string | undefined; body: Uint8Array }
  /** No Spade listened, or none is known: nothing was sent. */
  | { kind: "unreachable" }
  | { kind: "error"; code: string; message: string };

export type DirectLiveEvent =
  | { streamId: string; kind: "frame"; event: string; data: string }
  | {
      streamId: string;
      kind: "ended";
      reason: Exclude<SpadeLiveEndReason, "restarted" | "unsubscribed"> | "unreachable";
      status: number | undefined;
    };

export interface DirectRequest {
  method: SpadeMethod;
  path: string;
  body?: string | undefined;
  contentType?: string | undefined;
}

export interface DesktopSpade {
  /**
   * The identity (`hostId`) of this computer's daemon, whose Spade the app reaches directly;
   * null when the app knows no Spade it speaks to here.
   */
  localHost(): Promise<string | null>;
  /** Spade's `/health`, straight from Spade; null when nothing answers. */
  health(): Promise<{ version: string | undefined } | null>;
  request(request: DirectRequest): Promise<DirectAnswer>;
  openLive(streamId: string, path: string): Promise<void>;
  closeLive(streamId: string): Promise<void>;
  onLive(listener: (event: DirectLiveEvent) => void): () => void;
  onEndpointChanged(listener: () => void): () => void;
}

type Bag = { get(name: string): unknown };
/** Reads `value`'s fields, when it is an object. */
const record = (value: unknown): Bag | undefined =>
  typeof value === "object" && value !== null
    ? { get: (name) => Reflect.get(value, name) }
    : undefined;
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max ? value : undefined;
const status = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;

const unknownAnswer: DirectAnswer = {
  kind: "error",
  code: "failed",
  message: "The app gave an answer from Spade it couldn't read.",
};

export function readDirectAnswer(value: unknown): DirectAnswer {
  const answer = record(value);
  const kind = answer?.get("kind");
  if (kind === "unreachable") return { kind: "unreachable" };
  if (kind === "error")
    return {
      kind: "error",
      code: text(answer?.get("code"), 64) ?? "failed",
      message: text(answer?.get("message"), 2000) ?? "Spade couldn't be reached.",
    };
  const code = status(answer?.get("status"));
  const contentType = text(answer?.get("contentType"), 256);
  const body = answer?.get("body");
  if (code === undefined) return unknownAnswer;
  if (kind === "text" && typeof body === "string")
    return { kind: "text", status: code, contentType, body };
  if (kind === "bytes" && body instanceof Uint8Array)
    return { kind: "bytes", status: code, contentType, body };
  return unknownAnswer;
}

type DirectEnd = Extract<DirectLiveEvent, { kind: "ended" }>["reason"];
const endReasons: readonly DirectEnd[] = [
  "closed",
  "unreachable",
  "refused",
  "too_large",
  "invalid_path",
  "limit",
];
const isEndReason = (value: unknown): value is DirectEnd =>
  endReasons.some((reason) => reason === value);

export function readDirectLiveEvent(value: unknown): DirectLiveEvent | undefined {
  const event = record(value);
  const streamId = text(event?.get("streamId"), 128);
  if (!event || !streamId) return undefined;
  if (event.get("kind") === "frame") {
    const name = text(event.get("event"), 128);
    const data: unknown = event.get("data");
    return name !== undefined && typeof data === "string"
      ? { streamId, kind: "frame", event: name, data }
      : undefined;
  }
  const reason = event.get("reason");
  if (event.get("kind") !== "ended" || !isEndReason(reason)) return undefined;
  return { streamId, kind: "ended", reason, status: status(event.get("status")) };
}

/** `target[name]` bound to `target`, when it is a function. */
function method(target: unknown, name: string) {
  const value: unknown = record(target)?.get(name);
  return typeof value === "function"
    ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
    : undefined;
}

/** The bridge's unsubscribe, whatever it handed back. */
const unsubscribe = (stop: unknown) => () => {
  if (typeof stop === "function") stop();
};

/** `window.ace.spade`, or undefined outside the desktop app (or in one without it). */
export function desktopSpade(scope: object = globalThis): DesktopSpade | undefined {
  const spade: unknown = record(Reflect.get(scope, "ace"))?.get("spade");
  if (!record(spade)) return undefined;
  const [endpoint, health, request, openLive, closeLive, onLive, onEndpointChanged] = [
    "endpoint",
    "health",
    "request",
    "openLive",
    "closeLive",
    "onLive",
    "onEndpointChanged",
  ].map((name) => method(spade, name));
  if (!endpoint || !health || !request || !openLive || !closeLive || !onLive || !onEndpointChanged)
    return undefined;
  return {
    localHost: async () => text(record(await endpoint())?.get("hostId"), 128) || null,
    async health() {
      const answer = record(await health());
      return answer ? { version: text(answer.get("version"), 64) } : null;
    },
    request: async (input) => readDirectAnswer(await request(input)),
    openLive: async (streamId, path) => void (await openLive({ streamId, path })),
    closeLive: async (streamId) => void (await closeLive(streamId)),
    onLive: (listener) =>
      unsubscribe(
        onLive((value: unknown) => {
          const event = readDirectLiveEvent(value);
          if (event) listener(event);
        }),
      ),
    onEndpointChanged: (listener) => unsubscribe(onEndpointChanged(() => listener())),
  };
}
