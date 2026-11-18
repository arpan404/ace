import { mediaAdmission } from "./services/media-connect.ts";
import {
  connectHostToRelay,
  type HostChannel,
  type HostHttpOptions,
  type RelayRefusedError,
} from "@ace/relay";
import { randomUUID } from "node:crypto";
import { attachRelayService, type RelayServices } from "./services/relay-channel.ts";
import { mayCompress } from "./compression-policy.ts";
import { HostId } from "@ace/protocol";
import type { KeyPair } from "@ace/secure-channel";
import { allows, type Devices } from "./devices.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import type { MachineAccount } from "./account-access/machine-account.ts";
import { mainActor, relayHello } from "./relay-hello.ts";
import { hostId as hostIdOf } from "@ace/secure-channel";
import { NkAdmission, type NkClock } from "./relay-nk/admission.ts";
import { nkHost, type EarlyMain } from "./relay-nk/host.ts";
import type { RelayedMain } from "./relay-socket.ts";
import { AccessError } from "./remote-auth.ts";
import type { ClientMessage, PairResult } from "@ace/protocol";
import type { MediaRelayStreams } from "./media-relay/streams.ts";
import { mediaHelloAdmission, type MediaTicketClaim } from "./media-relay/admit.ts";
import { serveRelayMachineCalls } from "./relay-machine-host.ts";
import type { MachineTarget } from "./machines/target.ts";

/** The production host composes authenticated relay frames with the same file service. */
export async function startFilesRelay(
  options: RelayServices & {
    url: string;
    keys: KeyPair;
    auth: RemoteAuth;
    devices: Devices;
    hostId: string;
    headSeq(): number;
    /** Admits devices on this machine's ace account (ADR 0111). */
    account?: MachineAccount | undefined;
    /** Machine grants and labels for ace's hosted relay (ADR 0111). */
    relayAccount?:
      | { grant(signal: AbortSignal): Promise<string>; name?: string; platform?: string }
      | undefined;
    onRefused?: ((error: RelayRefusedError) => void) | undefined;
    /** Registration on the relay came (`true`) or was lost and is being retried (`false`). */
    onRegistration?: ((registered: boolean) => void) | undefined;
    /** Serves a main conversation channel (a hello without `channel`). */
    relayMain?: ((entry: RelayedMain) => void) | undefined;
    /** Machine calls from paired machines that reach this one only through the relay (ADR 0182). */
    machineCalls?: (() => Pick<MachineTarget, "handle"> | undefined) | undefined;
    /** Forwarded HTTP from ace's hosted relay (`relay-http.ts`, ADR 0122). */
    http?: HostHttpOptions | undefined;
    /**
     * Relay media streams (ADR 0147 §5.2): registers with the `media` feature and hands each
     * `purpose=media` ticket to ace-media, admitting its hello with `claim`.
     */
    media?: { streams: MediaRelayStreams; claim: MediaTicketClaim } | undefined;
    /**
     * Time for the NK admission limits (ADR 0155): the daemon's clock and timers. Without it,
     * the system's.
     */
    nkClock?: NkClock | undefined;
    /**
     * Gives up the registration: aborted, an unanswered one stops at once instead of waiting
     * out its deadline, and a running one stops as `close` would.
     */
    signal?: AbortSignal | undefined;
    /** This daemon's `ace-client` name (ADR 0189), sent on each upgrade to ace's own relay. */
    aceClient?: string | undefined;
  },
) {
  const media = options.media;
  const admitMedia = media
    ? mediaHelloAdmission({
        auth: options.auth,
        devices: options.devices,
        account: options.account,
        hostId: options.hostId,
        claim: media.claim,
      })
    : undefined;
  const clients = new Map<HostChannel, string>();
  // Main channels close on revocation in the main-socket handler, with its close code.
  const mains = new Set<HostChannel>();
  // Account devices keep access only while the machine stays on their account and they hold
  // the current machine code.
  const accountClients = new Map<HostChannel, () => boolean>();
  const stopAccount = options.account?.onChange(() => {
    for (const [channel, admitted] of accountClients) if (!admitted()) channel.close();
  });
  const controller = new AbortController();
  const stopRevoked = options.auth.onRevoke((id) => {
    for (const [channel, device] of clients) if (device === id) channel.close();
  });
  // A channel opened with a credential since replaced (the install paired again) ends too.
  const stopReplaced = options.auth.onCredentialReplaced((id) => {
    for (const [channel, device] of clients) if (device === id) channel.close();
  });
  // Tickets handed on this relay are bound to its key; a welcome on it announces NK.
  const relayEpoch = hostIdOf(options.keys.publicKey);
  const admission = new NkAdmission(
    options.nkClock ?? {
      now: () => options.auth.now(),
      schedule(ms, run) {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
    },
  );
  /** An admitted NK main channel: served as a main socket that waits for its confirmation. */
  const serveEarly = async (entry: EarlyMain) => {
    const { channel, early } = entry;
    if (!options.relayMain || clients.size + mains.size >= 64) {
      entry.session.close();
      channel.close();
      return;
    }
    // Credit fragments go only to a client that asked; its first one follows the NK answer.
    if (early.flowControl?.includes("credit")) channel.flowControl?.();
    mains.add(channel);
    if (entry.stillAdmitted) accountClients.set(channel, entry.stillAdmitted);
    // The main-socket handler reads it as a hello; its credential was checked already.
    const hello = {
      type: "hello",
      protocolVersion: 1,
      deviceId: early.deviceId,
      ...(early.ticket !== undefined ? { ticket: early.ticket } : { grant: early.grant }),
      ...(early.trims ? { trims: early.trims } : {}),
      ...(early.framing ? { framing: early.framing } : {}),
      ...(early.compression ? { compression: early.compression } : {}),
      ...(early.flowControl ? { flowControl: early.flowControl } : {}),
    };
    try {
      options.relayMain({
        channel,
        hello: JSON.stringify(hello),
        actor: entry.actor,
        stillAdmitted: entry.stillAdmitted,
        account: entry.account,
        grantExpiresAt: entry.grantExpiresAt,
        deflate: early.compression?.includes("deflate-raw") === true,
        relayEpoch,
        early: {
          subscribes: early.subscribes ?? [],
          session: entry.session,
          confirmed: entry.confirmed,
          readable: Promise.withResolvers<boolean>(),
          continuations: [],
        },
      });
      await channel.closed;
    } finally {
      entry.session.close();
      mains.delete(channel);
      accountClients.delete(channel);
    }
  };
  const nk = options.relayMain
    ? nkHost({
        admission,
        epoch: relayEpoch,
        auth: options.auth,
        devices: options.devices,
        account: options.account,
        serve: serveEarly,
      })
    : undefined;
  const deadline = setTimeout(() => controller.abort(), 15_000);
  try {
    const connection = await connectHostToRelay({
      relayUrl: options.url,
      hostKeys: options.keys,
      signal: options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal,
      ...(options.relayAccount ? { account: options.relayAccount } : {}),
      ...(options.onRefused ? { onRefused: options.onRefused } : {}),
      ...(options.onRegistration ? { onRegistration: options.onRegistration } : {}),
      ...(options.http ? { http: options.http } : {}),
      ...(nk ? { nk } : {}),
      ...(options.aceClient ? { aceClient: options.aceClient } : {}),
      ...(media && admitMedia
        ? {
            media: {
              offer: (_ticket: string, url: string, reject: () => void) =>
                media.streams.offer(url, admitMedia, reject),
            },
          }
        : {}),
      async onClientChannel(channel) {
        const hello = await channel.receive();
        if (hello.type === "pair.redeem") {
          await redeemPairing(channel, hello, options.auth);
          return;
        }
        if (hello.type !== "hello" || clients.size + mains.size >= 64) {
          channel.close();
          return;
        }
        const admitted = await relayHello(hello, options);
        if (!admitted.device) {
          if (admitted.refusal) await channel.send(admitted.refusal).catch(() => {});
          channel.close();
          return;
        }
        const device = admitted.device;
        // Credit fragments go only to a client that asked; its first one precedes the welcome.
        if (hello.flowControl?.includes("credit")) channel.flowControl?.();
        if (hello.channel === undefined) {
          const actor = mainActor(device, admitted.stillAdmitted, options);
          if (!actor || !options.relayMain) {
            await channel
              .send({ type: "error", code: "unauthorized", message: "Valid hello required" })
              .catch(() => {});
            channel.close();
            return;
          }
          channel.authorize();
          mains.add(channel);
          if (admitted.stillAdmitted) accountClients.set(channel, admitted.stillAdmitted);
          try {
            options.relayMain({
              channel,
              hello: JSON.stringify(hello),
              actor,
              stillAdmitted: admitted.stillAdmitted,
              account: admitted.account,
              grantExpiresAt: admitted.grantExpiresAt,
              deflate: hello.compression?.includes("deflate-raw") === true,
              relayEpoch,
            });
            await channel.closed;
          } finally {
            mains.delete(channel);
            accountClients.delete(channel);
          }
          return;
        }
        // A paired machine's calls (ADR 0182): paired devices only, never an account device.
        if (hello.channel === "machine") {
          if (admitted.stillAdmitted || !options.machineCalls) {
            await channel
              .send({ type: "error", code: "unauthorized", message: "Valid hello required" })
              .catch(() => {});
            channel.close();
            return;
          }
          channel.authorize();
          clients.set(channel, device.id);
          try {
            await serveRelayMachineCalls(channel, {
              target: options.machineCalls,
              device: () =>
                options.devices.current(device.id, device.generation, options.auth.now()),
              deviceId: device.id,
              hostId: options.hostId,
              headSeq: options.headSeq,
            });
          } finally {
            clients.delete(channel);
            channel.close();
          }
          return;
        }
        // A media hello comes only on a `purpose=media` stream, which ace-media holds; on any
        // other it is refused before anything is served.
        if (hello.channel === "media") {
          await channel
            .send({ type: "error", code: "unauthorized", message: "Valid hello required" })
            .catch(() => {});
          channel.close();
          return;
        }
        channel.authorize();
        // An account device shares its id with the same install's pairing (ADR 0115): revoking
        // that pairing closes only what the pairing opened. An empty id matches no revocation.
        clients.set(channel, admitted.stillAdmitted ? "" : device.id);
        if (admitted.stillAdmitted) accountClients.set(channel, admitted.stillAdmitted);
        // Sign-in traffic carries codes and links: that channel never compresses anything.
        if (hello.compression?.includes("deflate-raw") && hello.channel !== "provider_auth")
          channel.compress?.((message) => mayCompress(message.type));
        let session: ReturnType<typeof attachRelayService>;
        try {
          // `options` is passed as is, never spread: its service fields may read live state.
          session = attachRelayService(options, {
            channel,
            kind: hello.channel ?? "files",
            device: device.id,
            sessionId: randomUUID(),
            admission: mediaAdmission(admitted.account, device.generation),
            authorize: (scope) => {
              // An account device holds admin, for as long as it stays admitted.
              if (admitted.stillAdmitted) return admitted.stillAdmitted();
              const current = options.devices.current(
                device.id,
                device.generation,
                options.auth.now(),
              );
              return current !== undefined && allows(current, scope);
            },
          });
        } catch {
          clients.delete(channel);
          accountClients.delete(channel);
          channel.close();
          return;
        }

        try {
          await channel.send({
            type: "welcome",
            hostId: HostId.parse(options.hostId),
            protocolVersion: 1,
            headSeq: options.headSeq(),
          });
          for await (const frame of channel.frames()) {
            if (frame instanceof Uint8Array)
              session.binary(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength));
            else if (frame.type === "ping") await channel.send({ type: "pong" });
            else await session.accept(frame);
          }
        } finally {
          session.close();
          clients.delete(channel);
          accountClients.delete(channel);
        }
      },
    });
    clearTimeout(deadline);
    return {
      hostId: connection.hostId,
      async close() {
        stopRevoked();
        stopReplaced();
        stopAccount?.();
        controller.abort();
        await connection.close();
      },
    };
  } catch (error) {
    stopRevoked();
    stopReplaced();
    stopAccount?.();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Redeem a pairing code that came through a self-hosted relay (ADR 0070): the same single-use,
 * five-minute code and host-chosen scopes as `POST /v1/pair`, rate limited together as one
 * source. The answer is the channel's only message; nothing about it is logged.
 */
async function redeemPairing(
  channel: HostChannel,
  request: Extract<ClientMessage, { type: "pair.redeem" }>,
  auth: RemoteAuth,
): Promise<void> {
  let result: PairResult["result"];
  try {
    auth.pairingAttempt("relay");
    result = { ok: true, ...auth.redeem(request.code, request.name, request.installId) };
  } catch (error) {
    const status = error instanceof AccessError ? error.status : 500;
    result =
      status === 429
        ? {
            ok: false,
            error: "rate_limited",
            message: "Too many pairing attempts. Try again in a minute.",
          }
        : status === 401
          ? { ok: false, error: "invalid", message: "That pairing code is wrong, used or expired." }
          : { ok: false, error: "unavailable", message: "Couldn't pair right now. Try again." };
  }
  await channel.send({ type: "pair.result", result }).catch(() => {});
  channel.close();
}
