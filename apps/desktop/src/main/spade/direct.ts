import { maxSpadeResponseBytes, maxSpadeUploadBytes } from "@ace/protocol";
import {
  checkLivePath,
  checkSpadePath,
  isTextContentType,
  neverConnected,
  proveSpade,
  requestBodyLimit,
  responseBodyLimit,
  spadeLive,
  spadeRequest,
  type LiveEnd,
  type SpadeAnswer,
  type SpadeHealth,
} from "@ace/service/spade";
import type {
  SpadeDirectAnswer,
  SpadeDirectRequest,
  SpadeEndpointInfo,
  SpadeHealthInfo,
  SpadeLiveEvent,
} from "../../shared/spade.ts";
import type { LocalSpade, SpadeEndpointWatch } from "./endpoint-watch.ts";

/** Live streams the app keeps open at once, across its windows. */
const maxStreams = 16;
const requestMs = 60_000;
/** A message with eight images on a busy machine. */
const uploadMs = 5 * 60_000;
const healthMs = 3_000;

/** The same Spade, or one that restarted (a new port or token)? */
const sameSpade = (a: LocalSpade | undefined, b: LocalSpade | undefined) =>
  a !== undefined && b !== undefined && a.port === b.port && a.token === b.token;

/**
 * The desktop app's direct path to Spade (ADR 0123): requests and live streams on loopback
 * with Spade's token, which stays in this process. The routes and caps are the daemon
 * forwarder's. When Spade restarted under a request (nothing listens at the old port, or the
 * token is stale) its files are read again and the request is sent once more; a request that
 * may have reached Spade is never sent twice.
 *
 * The token goes only to a Spade that proved it holds it: before the first tokened request to a
 * reading of Spade's files (and after every re-read), `/health` with a fresh nonce must answer
 * the right proof (`proveSpade`). Anything else at that address is treated as no Spade.
 */
export function spadeDirect(
  endpoints: Pick<SpadeEndpointWatch, "current" | "refresh">,
  options: { nonce(): string },
) {
  const streams = new Map<string, { controller: AbortController; owner: number }>();
  /** Readings whose Spade proved it holds their token (each re-read is a new reading). */
  const trusted = new WeakMap<LocalSpade, Promise<boolean>>();

  /** Spade's health, from the Spade at `spade` that holds its token only; marks it trusted. */
  async function check(spade: LocalSpade): Promise<SpadeHealth | undefined> {
    const answer = await proveSpade(spade, options.nonce(), AbortSignal.timeout(healthMs));
    if (answer) trusted.set(spade, Promise.resolve(true));
    return answer;
  }

  /** Whether the token may go to `spade`: proved once per reading; a failure is asked again. */
  function proven(spade: LocalSpade): Promise<boolean> {
    let proving = trusted.get(spade);
    if (!proving) {
      proving = check(spade).then((answer) => {
        if (!answer) trusted.delete(spade);
        return answer !== undefined;
      });
      trusted.set(spade, proving);
    }
    return proving;
  }

  /** The Spade the token may go to now: this reading, or a fresh one if this one fails. */
  async function trustedSpade(): Promise<LocalSpade | undefined> {
    const spade = await endpoints.current();
    if (!spade) return undefined;
    if (await proven(spade)) return spade;
    const again = await endpoints.refresh();
    return again && !sameSpade(spade, again) && (await proven(again)) ? again : undefined;
  }

  /** Run `attempt` against Spade, and once more against a restarted Spade if it needs one. */
  async function withSpade<T>(
    attempt: (spade: LocalSpade) => Promise<T>,
    retry: (result: T) => boolean,
  ): Promise<T | undefined> {
    const spade = await trustedSpade();
    if (!spade) return undefined;
    const result = await attempt(spade);
    if (!retry(result)) return result;
    const again = await endpoints.refresh();
    if (!again || sameSpade(spade, again) || !(await proven(again))) return result;
    return attempt(again);
  }

  async function request(input: SpadeDirectRequest): Promise<SpadeDirectAnswer> {
    const checked = checkSpadePath(input.path);
    if (!checked.ok) return { kind: "error", code: "invalid_path", message: checked.message };
    const body = input.body === undefined ? undefined : Buffer.from(input.body, "utf8");
    const limit = requestBodyLimit(input.method, input.path);
    if (body && body.length > limit)
      return { kind: "error", code: "too_large", message: "That's more than Spade takes." };
    type Outcome = SpadeAnswer | "unreachable" | "failed";
    const outcome = await withSpade<Outcome>(
      async (spade) => {
        try {
          return await spadeRequest(
            spade,
            {
              method: input.method,
              path: input.path,
              body,
              ...(body ? { contentType: input.contentType ?? "application/json" } : {}),
            },
            {
              signal: AbortSignal.timeout(limit === maxSpadeUploadBytes ? uploadMs : requestMs),
              maxBytes: responseBodyLimit(input.method, input.path),
            },
          );
        } catch (error) {
          return neverConnected(error) ? "unreachable" : "failed";
        }
      },
      (result) => result === "unreachable" || (typeof result === "object" && unauthorized(result)),
    );
    if (outcome === undefined || outcome === "unreachable") return { kind: "unreachable" };
    if (outcome === "failed")
      return { kind: "error", code: "failed", message: "Spade didn't answer." };
    if (outcome.kind === "too_large")
      return { kind: "error", code: "too_large", message: "Spade's answer was too large." };
    const contentType = outcome.contentType?.slice(0, 256);
    const status = outcome.status;
    return isTextContentType(contentType)
      ? { kind: "text", status, contentType, body: outcome.body.toString("utf8") }
      : { kind: "bytes", status, contentType, body: new Uint8Array(outcome.body) };
  }

  async function endpoint(): Promise<SpadeEndpointInfo> {
    const spade = await trustedSpade();
    if (!spade) return null;
    const { version, api, hostId } = spade;
    return { address: `${spade.host}:${spade.port}`, version, api, hostId };
  }

  async function health(): Promise<SpadeHealthInfo> {
    // Asked afresh every time (it says whether Spade is up now), and proved like any request.
    const spade = await endpoints.current();
    let answer = spade && (await check(spade));
    if (!answer) {
      const again = await endpoints.refresh();
      if (again && !sameSpade(spade, again)) answer = await check(again);
    }
    if (!answer) return null;
    return {
      ...(answer.version === undefined ? {} : { version: answer.version }),
      ...(answer.api === undefined ? {} : { api: answer.api }),
    };
  }

  /**
   * Opens a live stream for window `owner`; `emit` gets its frames and then exactly one end,
   * unless `closeLive` ends it first. An id already streaming carries on.
   */
  function openLive(
    owner: number,
    input: { streamId: string; path: string },
    emit: (event: SpadeLiveEvent) => void,
  ): void {
    const { streamId, path } = input;
    if (streams.has(streamId)) return;
    const ended = (reason: Extract<SpadeLiveEvent, { kind: "ended" }>["reason"], status?: number) =>
      emit({ streamId, kind: "ended", reason, ...(status === undefined ? {} : { status }) });
    if (!checkLivePath(path).ok) return ended("invalid_path");
    if (streams.size >= maxStreams) return ended("limit");
    const stream = { controller: new AbortController(), owner };
    streams.set(streamId, stream);
    let framed = false;
    void withSpade<LiveEnd>(
      (spade) =>
        spadeLive(spade, path, {
          signal: stream.controller.signal,
          maxEventChars: maxSpadeResponseBytes,
          onEvent(event) {
            framed = true;
            emit({ streamId, kind: "frame", event: event.event.slice(0, 128), data: event.data });
          },
        }),
      (result) =>
        !framed &&
        (result.kind === "unreachable" || (result.kind === "refused" && result.status === 401)),
    ).then((result) => {
      if (streams.get(streamId) !== stream) return;
      streams.delete(streamId);
      if (!result) return ended("unreachable");
      if (result.kind === "aborted") return;
      if (result.kind === "refused") return ended("refused", result.status);
      ended(result.kind);
    });
  }

  function closeLive(streamId: string): void {
    const stream = streams.get(streamId);
    if (!stream) return;
    streams.delete(streamId);
    stream.controller.abort();
  }

  /** A window closed or loaded another page: its streams have no one to go to. */
  function closeOwner(owner: number): void {
    for (const [streamId, stream] of streams) if (stream.owner === owner) closeLive(streamId);
  }

  return { request, endpoint, health, openLive, closeLive, closeOwner };
}

export type SpadeDirect = ReturnType<typeof spadeDirect>;

const unauthorized = (answer: SpadeAnswer) => answer.kind === "response" && answer.status === 401;
