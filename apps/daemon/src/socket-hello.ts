import type { ClientMessage, DeviceId } from "@ace/protocol";
import type { Device } from "./devices.ts";
import type { RemoteAuth } from "./remote-auth.ts";

type Hello = Extract<ClientMessage, { type: "hello" }>;

/**
 * The device a hello authenticates, or undefined when it authenticates nothing. The host token
 * counts only on loopback. A ticket or a desktop bearer must name the device the hello claims,
 * and both stay revocable; the host token does not.
 */
export function helloActor(
  message: Hello,
  auth: RemoteAuth,
  isLocal: boolean,
): (Device & { revocable: boolean }) | undefined {
  const bearer =
    message.token !== undefined && isLocal && !auth.local(message.token)
      ? auth.deviceBearer(message.token)
      : undefined;
  // Local-only credentials the daemon minted itself: the desktop app's, and the "Use my Chrome"
  // native host's (ADR 0084), which authorizes nothing but registering a browser link.
  const desktop =
    bearer?.scopes.includes("desktop") || bearer?.scopes.includes("user-browser")
      ? bearer
      : undefined;
  const actor =
    message.ticket !== undefined
      ? auth.consume(message.ticket)
      : message.token !== undefined && isLocal && auth.local(message.token)
        ? {
            id: message.deviceId,
            name: "Host",
            scopes: ["admin", "projects", "accounts"] as const,
            createdAt: 0,
            lastSeenAt: auth.now(),
            revokedAt: null,
          }
        : desktop;
  const revocable = message.ticket !== undefined || desktop !== undefined;
  if (!actor || (revocable && actor.id !== message.deviceId)) return undefined;
  return { ...actor, scopes: [...actor.scopes], revocable };
}

/**
 * Register a readable device for notifications, retrying failures with capped backoff while the
 * socket stays open and readable.
 */
export function enrollNotifications(
  device: DeviceId,
  options: {
    connect(device: DeviceId): Promise<unknown>;
    active(): boolean;
    delay(run: () => void, milliseconds: number): () => void;
    log(error: unknown): void;
    tasks: Set<Promise<void>>;
    scheduled(stop: () => void): void;
  },
): void {
  let attempt = 0;
  const enroll = () => {
    if (!options.active()) return;
    const task = options
      .connect(device)
      .then(() => undefined)
      .catch((error: unknown) => {
        options.log(error);
        if (!options.active()) return;
        options.scheduled(options.delay(enroll, Math.min(30000, 1000 * 2 ** attempt)));
        attempt = Math.min(attempt + 1, 5);
      });
    options.tasks.add(task);
    void task.finally(() => options.tasks.delete(task));
  };
  enroll();
}
