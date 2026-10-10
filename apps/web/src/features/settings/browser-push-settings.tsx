import { useToast } from "@/components/ui/toast.tsx";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { useClient } from "@ace/client-react";
import { useEffect, useState } from "react";
import { WebPushSubscription } from "@ace/protocol/notifications";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { browserPermission, requestBrowserPermission } from "@/lib/browser-notify.ts";

export default function BrowserPushSettings() {
  const client = useClient();
  const toast = useToast();
  const config = useDaemonQuery({
    queryKey: ["notification-config"],
    read: (api, signal) => api.request({ type: "notification.config" }, { signal }),
  });
  const key = config.data?.publicKey;
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    if (key && "serviceWorker" in navigator) {
      void navigator.serviceWorker
        .getRegistration("/")
        .then(async (registration) => {
          const subscription = await registration?.pushManager.getSubscription();
          if (!stopped) setOn(Boolean(subscription));
        })
        .catch(() => {
          if (!stopped) {
            const message = "Couldn't check browser notifications. Try again.";
            setError(message);
            toast.error({ title: message });
          }
        });
    }
    return () => {
      stopped = true;
    };
  }, [key, toast]);
  if (
    browserPermission() === "unsupported" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in globalThis)
  )
    return null;
  if (config.isError && !key)
    return (
      <SettingSection label="When ace is closed" scope="device">
        <SettingRow title="Push notifications" description="Couldn't check push notifications.">
          <Button size="sm" variant="ghost" onClick={() => void config.refetch()}>
            Try again
          </Button>
        </SettingRow>
      </SettingSection>
    );
  if (!key) return null;
  const blocked = browserPermission() === "denied";
  return (
    <SettingSection label="When ace is closed" scope="device">
      <SettingRow
        density="compact"
        title="Push notifications"
        description={
          blocked
            ? "Allow notifications in this browser’s site settings, then try again."
            : "Receive notifications even after closing this tab."
        }
      >
        <Button
          variant="ghost"
          disabled={busy || blocked}
          onClick={() => {
            setBusy(true);
            setError("");
            void (async () => {
              if ((await requestBrowserPermission()) !== "granted") throw new Error("permission");
              const registration = await navigator.serviceWorker.register(
                "/notification-worker.js",
                { scope: "/", type: "module" },
              );
              await navigator.serviceWorker.ready;
              const subscription = await registration.pushManager.getSubscription();
              if (on) {
                await client.request({
                  type: "notification.register",
                  device: { channel: "websocket", platform: "web" },
                });
                await subscription?.unsubscribe();
                setOn(false);
                return;
              }
              const bytes = Uint8Array.from(
                atob(key.replace(/-/g, "+").replace(/_/g, "/")),
                (letter) => letter.charCodeAt(0),
              );
              const next =
                subscription ??
                (await registration.pushManager.subscribe({
                  userVisibleOnly: true,
                  applicationServerKey: bytes,
                }));
              const json = next.toJSON();
              const parsed = WebPushSubscription.parse({
                endpoint: json.endpoint,
                p256dh: json.keys?.p256dh,
                auth: json.keys?.auth,
              });
              await client.request({
                type: "notification.register",
                device: { channel: "webpush", platform: "web", subscription: parsed },
              });
              setOn(true);
            })()
              .catch(() => {
                const message =
                  "Couldn't change push notifications. Check this browser’s notification permission and try again.";
                setError(message);
                toast.error({ title: message });
              })
              .finally(() => setBusy(false));
          }}
        >
          {on ? "Disable push on this browser" : "Enable push on this browser"}
        </Button>
      </SettingRow>
      {blocked && (
        <p className="text-sm text-muted-foreground">
          Allow notifications in this browser’s site settings, then try again.
        </p>
      )}
      {error && (
        <p role="alert" className="text-ui text-destructive">
          {error}
        </p>
      )}
    </SettingSection>
  );
}
