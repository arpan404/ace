import { connectHostToRelay, type HostChannel, type RelayRefusedError } from "@ace/relay";
import { randomUUID } from "node:crypto";
import { attachRelayService, type RelayServices } from "./services/relay-channel.ts";
import { mayCompress } from "./compression-policy.ts";
import { HostId } from "@ace/protocol";
import type { KeyPair } from "@ace/secure-channel";
import { activeDevice, allows, type Devices } from "./devices.ts";
import type { RemoteAuth } from "./remote-auth.ts";
import type { MachineAccount } from "./account-access/machine-account.ts";
import { relayHello } from "./relay-hello.ts";

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
    /** A fresh machine grant per registration, for ace's hosted relay. */
    grant?: (() => Promise<string>) | undefined;
    onRefused?: ((error: RelayRefusedError) => void) | undefined;
  },
) {
  const clients = new Map<HostChannel, string>();
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
  const deadline = setTimeout(() => controller.abort(), 15_000);
  try {
    const connection = await connectHostToRelay({
      relayUrl: options.url,
      hostKeys: options.keys,
      signal: controller.signal,
      ...(options.grant ? { grant: options.grant } : {}),
      ...(options.onRefused ? { onRefused: options.onRefused } : {}),
      async onClientChannel(channel) {
        const hello = await channel.receive();
        if (hello.type !== "hello" || clients.size >= 64) {
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
        channel.authorize();
        clients.set(channel, device.id);
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
              const current = options.devices.get(device.id);
              return activeDevice(current, options.auth.now()) && allows(current, scope);
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
        stopAccount?.();
        controller.abort();
        await connection.close();
      },
    };
  } catch (error) {
    stopRevoked();
    stopAccount?.();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
