/*
 * Push alerts for outside clients' sign-in requests (ADR 0117, "Consent happens in ace"). The
 * person is often away from the computer when claude.ai asks to sign in, and the request lives
 * ten minutes, so each new request goes once to the push address of every admin phone. A phone
 * with ace open already sees it through `outside.state`; the push is for one that is closed or
 * suspended. A push can't be recalled once accepted (ADR 0106), so a request that ends stops
 * any send or retry still waiting, and the push itself expires with the request.
 */
import type { DeliveryResult } from "@ace/notify";
import type {
  Device,
  DeviceId,
  NotificationDevice,
  OutsideAccessRequest,
  PushAccessAlert,
} from "@ace/protocol";
import { activeDevice, allows } from "../devices.ts";

/** The push half the notification service lends: addresses from its device table, and a send. */
export type AccessPush = Pick<AccessAlertPorts, "addresses" | "send">;
export interface AccessAlertPorts {
  /** Every paired device; only active admins are alerted, since only they can approve. */
  devices(): readonly Pick<Device, "id" | "scopes" | "revokedAt" | "expiresAt">[];
  now(): number;
  /** Their push addresses that may be alerted now (not muted, not gone). */
  addresses(devices: readonly DeviceId[]): Promise<readonly NotificationDevice[]>;
  send(
    device: NotificationDevice,
    alert: PushAccessAlert,
    signal: AbortSignal,
  ): Promise<DeliveryResult>;
  after(ms: number, run: () => void): () => void;
  report(error: unknown): void;
}
interface Requests {
  current(): readonly OutsideAccessRequest[];
  subscribe(listener: (requests: readonly OutsideAccessRequest[]) => void): () => void;
}
/** Waits between tries when the gateway asks to retry; the request outlives all of them. */
const retryDelays = [2_000, 10_000, 30_000];

/** What a push may say about a request: never its scopes, grant or anything that signs in. */
export function accessAlert(request: OutsideAccessRequest): PushAccessAlert {
  return {
    requestId: request.requestId,
    clientName: request.clientName,
    domain: request.domain,
    matchCode: request.matchCode,
    expiresAt: request.expiresAt,
  };
}

/** Alerts admin phones about each new sign-in request, once. Returns a stop. */
export function alertAccessRequests(requests: Requests, ports: AccessAlertPorts): () => void {
  const open = new Map<string, AbortController>();
  const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const cancel = ports.after(ms, done);
      signal.addEventListener("abort", done, { once: true });
      function done() {
        cancel();
        signal.removeEventListener("abort", done);
        resolve();
      }
    });
  const sendOne = async (
    device: NotificationDevice,
    alert: PushAccessAlert,
    signal: AbortSignal,
  ) => {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) return;
      const result = await ports.send(device, alert, signal);
      const delay = retryDelays[attempt];
      if (result !== "retry" || delay === undefined) return;
      await wait(delay, signal);
    }
  };
  const alert = async (request: OutsideAccessRequest, signal: AbortSignal) => {
    const at = ports.now();
    const admins = ports
      .devices()
      .filter((device) => activeDevice(device, at) && allows(device, "admin"))
      .map((device) => device.id);
    if (!admins.length) return;
    const devices = await ports.addresses(admins);
    const payload = accessAlert(request);
    await Promise.all(devices.map((device) => sendOne(device, payload, signal)));
  };
  const changed = (pending: readonly OutsideAccessRequest[]) => {
    const live = new Set(pending.map((request) => request.requestId));
    // Decided, expired or cancelled: nothing more goes out for it.
    for (const [id, controller] of open)
      if (!live.has(id)) {
        controller.abort();
        open.delete(id);
      }
    for (const request of pending) {
      if (open.has(request.requestId)) continue;
      const controller = new AbortController();
      open.set(request.requestId, controller);
      void alert(request, controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted) ports.report(error);
      });
    }
  };
  const unsubscribe = requests.subscribe(changed);
  changed(requests.current());
  return () => {
    unsubscribe();
    for (const controller of open.values()) controller.abort();
    open.clear();
  };
}
