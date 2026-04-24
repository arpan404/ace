export interface BrowserNotificationInput {
  readonly body: string;
  readonly data?: Record<string, unknown>;
  readonly onClick?: () => void;
  readonly requireInteraction?: boolean;
  readonly tag?: string;
  readonly title: string;
}

const BROWSER_NOTIFICATION_SERVICE_WORKER_URL = "/ace-notifications-sw.js";

function canUseServiceWorkerNotifications(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof ServiceWorkerRegistration !== "undefined" &&
    "showNotification" in ServiceWorkerRegistration.prototype
  );
}

async function resolveNotificationServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!canUseServiceWorkerNotifications()) {
    return null;
  }

  try {
    const existing = await navigator.serviceWorker.getRegistration("/");
    if (existing?.active?.scriptURL.endsWith(BROWSER_NOTIFICATION_SERVICE_WORKER_URL)) {
      return existing;
    }
    return await navigator.serviceWorker.register(BROWSER_NOTIFICATION_SERVICE_WORKER_URL, {
      scope: "/",
    });
  } catch {
    return null;
  }
}

export async function showBrowserNotification(input: BrowserNotificationInput): Promise<boolean> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return false;
  }
  if (window.Notification.permission !== "granted") {
    return false;
  }

  const options: NotificationOptions = {
    body: input.body,
    ...(input.data ? { data: input.data } : {}),
    ...(typeof input.requireInteraction === "boolean"
      ? { requireInteraction: input.requireInteraction }
      : {}),
    ...(input.tag ? { tag: input.tag } : {}),
  };
  const registration = await resolveNotificationServiceWorkerRegistration();
  if (registration) {
    try {
      await registration.showNotification(input.title, options);
      return true;
    } catch {
      // Fall back to page notifications below.
    }
  }

  try {
    const notification = new window.Notification(input.title, options);
    if (input.onClick) {
      notification.addEventListener("click", () => {
        input.onClick?.();
        notification.close();
      });
    }
    if (!input.requireInteraction) {
      window.setTimeout(() => notification.close(), 3_500);
    }
    return true;
  } catch {
    return false;
  }
}

export async function closeBrowserNotificationsByTag(tag: string): Promise<void> {
  const registration = await resolveNotificationServiceWorkerRegistration();
  if (!registration || typeof registration.getNotifications !== "function") {
    return;
  }

  try {
    const notifications = await registration.getNotifications({ tag });
    for (const notification of notifications) {
      notification.close();
    }
  } catch {
    // Best-effort cleanup only.
  }
}
