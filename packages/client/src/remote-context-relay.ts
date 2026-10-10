import { authenticatedChannel, type AuthenticatedChannelOptions } from "./device-transport.ts";
import { RemoteDelegationResult, type ClientMessage } from "@ace/protocol";
import { ClientError } from "./errors.ts";
export interface RemoteContextChannel {
  request(
    message: Extract<ClientMessage, { type: "delegation.remote.context" }>,
  ): Promise<import("@ace/protocol").RemoteDelegationResult>;
  close(): void;
}
/** Dedicated encrypted files channel. No replay: durable upload offsets belong to the task. */
export function openRemoteContextRelay(
  options: AuthenticatedChannelOptions,
): Promise<RemoteContextChannel> {
  if (options.target.kind !== "relay") return Promise.reject(new ClientError("protocol"));
  const channel = authenticatedChannel(options, "files");
  const pending = new Map<
    string,
    {
      resolve(value: import("@ace/protocol").RemoteDelegationResult): void;
      reject(error: ClientError): void;
      cancel(): void;
    }
  >();
  let closed = false;
  let failReady: ((error: ClientError) => void) | undefined;
  let stopStartup: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    stopStartup?.();
    for (const entry of pending.values()) {
      entry.cancel();
      entry.reject(new ClientError("offline", "Encrypted task context relay disconnected"));
    }
    pending.clear();
    failReady?.(new ClientError("offline", "Encrypted task context relay unavailable"));
    channel.close();
  };
  const ready = new Promise<RemoteContextChannel>((resolve, reject) => {
    failReady = reject;
    stopStartup = options.schedule(close, 20000);
    channel.open({
      ready() {
        stopStartup?.();
        resolve({
          close,
          request(message) {
            if (closed) return Promise.reject(new ClientError("offline"));
            if (pending.size >= 16 || pending.has(message.requestId))
              return Promise.reject(new ClientError("limit"));
            return new Promise((resolveRequest, rejectRequest) => {
              const cancel = options.schedule(() => {
                pending.delete(message.requestId);
                rejectRequest(new ClientError("timeout"));
              }, 20000);
              pending.set(message.requestId, {
                resolve: resolveRequest,
                reject: rejectRequest,
                cancel,
              });
              void channel.send(message).catch(() => close());
            });
          },
        });
      },
      message(frame) {
        if (frame instanceof Uint8Array || frame.type !== "delegation.broker.result") {
          close();
          return;
        }
        const entry = pending.get(frame.requestId);
        if (!entry) return;
        pending.delete(frame.requestId);
        entry.cancel();
        entry.resolve(RemoteDelegationResult.parse(frame));
      },
      close,
    });
  });
  return ready;
}
