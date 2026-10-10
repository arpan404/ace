import { Notification } from "@ace/protocol/notifications";
import { z } from "zod";
import { notificationTitle } from "./lib/notification-title.ts";

interface PushEvent extends Event {
  data?: { json(): unknown };
  waitUntil(promise: Promise<unknown>): void;
}
interface ClickEvent extends Event {
  notification: { close(): void; data: unknown };
  waitUntil(promise: Promise<unknown>): void;
}
/** The service worker boundary; keeping its types local avoids merging worker and window globals. */
declare const self: {
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: ClickEvent) => void): void;
  registration: { showNotification(title: string, options: NotificationOptions): Promise<void> };
  clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<
      {
        url: string;
        focused: boolean;
        navigate(url: string): Promise<unknown>;
        focus(): Promise<unknown>;
      }[]
    >;
    openWindow(url: string): Promise<unknown>;
  };
  location: { origin: string };
};
const target = z.object({
  path: z
    .string()
    .max(1024)
    .regex(/^\/t\/[^/]+$/),
});

self.addEventListener("push", (event) => {
  let input: unknown;
  try {
    input = event.data?.json();
  } catch {
    return;
  }
  const parsed = Notification.safeParse(input);
  if (!parsed.success) return;
  const notice = parsed.data;
  event.waitUntil(
    self.registration.showNotification(notificationTitle(notice), {
      body: notice.message ?? notice.preview ?? "Your thread has an update",
      tag: notice.id,
      data: { path: `/t/${encodeURIComponent(notice.threadId)}` },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const parsed = target.safeParse(event.notification.data);
  if (!parsed.success) return;
  event.waitUntil(
    (async () => {
      const url = new URL(parsed.data.path, self.location.origin).href;
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows
        .filter((client) => new URL(client.url).origin === self.location.origin)
        .toSorted((a, b) => Number(b.focused) - Number(a.focused))[0];
      if (existing) {
        await existing.navigate(url);
        await existing.focus();
      } else await self.clients.openWindow(url);
    })(),
  );
});
