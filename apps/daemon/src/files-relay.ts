import { connectHostToRelay, type HostChannel } from "@ace/relay";
import { attachFilesRelay, type FilesService } from "@ace/files";
import { HostId } from "@ace/protocol";
import type { KeyPair } from "@ace/secure-channel";
import { allows, type Devices } from "./devices.ts";
import type { RemoteAuth } from "./remote-auth.ts";

/** The production host composes authenticated relay frames with the same file service. */
export async function startFilesRelay(options: {
  url: string;
  keys: KeyPair;
  files: FilesService;
  auth: RemoteAuth;
  devices: Devices;
  hostId: string;
  headSeq(): number;
}) {
  const clients = new Map<HostChannel, string>();
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
      async onClientChannel(channel) {
        const hello = await channel.receive();
        if (hello.type !== "hello") {
          channel.close();
          return;
        }
        // Relay credentials are paired-device tokens or one-use tickets, never the admin token.
        const device =
          hello.ticket !== undefined
            ? options.auth.consume(hello.ticket)
            : hello.token !== undefined
              ? options.auth.deviceBearer(hello.token)
              : undefined;
        if (!device || device.id !== hello.deviceId || clients.size >= 64) {
          channel.close();
          return;
        }
        channel.authorize();
        clients.set(channel, device.id);
        const session = attachFilesRelay(options.files, channel, device.id, (capability) => {
          const current = options.devices.get(device.id);
          return (
            current?.revokedAt === null &&
            allows(current, capability === "files.read" ? "read" : "operate")
          );
        });
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
            else session.accept(frame);
          }
        } finally {
          session.close();
          clients.delete(channel);
        }
      },
    });
    clearTimeout(deadline);
    return {
      hostId: connection.hostId,
      async close() {
        stopRevoked();
        controller.abort();
        await connection.close();
      },
    };
  } catch (error) {
    stopRevoked();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
