import { connectHostToRelay, type HostChannel, type RelayRefusedError } from "@ace/relay";
import { randomUUID } from "node:crypto";
import { attachRelayService, type RelayServices } from "./services/relay-channel.ts";
import { mayCompress } from "./compression-policy.ts";
import { HostId } from "@ace/protocol";
import type { KeyPair } from "@ace/secure-channel";
import { allows, type Devices } from "./devices.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import type { MachineAccount } from "./account-access/machine-account.ts";
import { accountDeviceActor, relayHello } from "./relay-hello.ts";
import type { RelayedMain } from "./relay-socket.ts";
import { AccessError } from "./remote-auth.ts";
import type { ClientMessage, PairResult } from "@ace/protocol";

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
    /** Serves a main conversation channel (a hello without `channel`). */
    relayMain?: ((entry: RelayedMain) => void) | undefined;
  },
) {
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
  const deadline = setTimeout(() => controller.abort(), 15_000);
  try {
    const connection = await connectHostToRelay({
      relayUrl: options.url,
      hostKeys: options.keys,
      signal: controller.signal,
      ...(options.relayAccount ? { account: options.relayAccount } : {}),
      ...(options.onRefused ? { onRefused: options.onRefused } : {}),
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
            });
            await channel.closed;
          } finally {
            mains.delete(channel);
            accountClients.delete(channel);
          }
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
 * Who a relayed main channel speaks for: a paired device with its stored scopes (never the
 * desktop app's local-only credential), or an account device holding admin while it stays
 * admitted (ADR 0111).
 */
function mainActor(
  admitted: { id: RelayedMain["actor"]["id"]; generation?: string | undefined },
  stillAdmitted: (() => boolean) | undefined,
  options: { auth: RemoteAuth; devices: Devices },
): RelayedMain["actor"] | undefined {
  if (stillAdmitted) return accountDeviceActor(admitted.id, options.auth.now());
  const device = options.devices.current(admitted.id, admitted.generation, options.auth.now());
  if (!device) return undefined;
  if (device.scopes.includes("desktop") || device.scopes.includes("user-browser")) return undefined;
  return { ...device, scopes: [...device.scopes], revocable: true };
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
