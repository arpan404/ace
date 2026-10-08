import { useClient } from "@ace/client-react";
import { useEffect, useState } from "react";
import { WebPushSubscription } from "@ace/protocol/notifications";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { browserPermission, requestBrowserPermission } from "@/lib/browser-notify.ts";

export default function BrowserPushSettings() {
  const client = useClient();
  const [key, setKey] = useState<string | null>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let stopped = false;
    void client
      .request({ type: "notification.config" })
      .then(async (reply) => {
        if (stopped) return;
        setKey(reply.publicKey);
        if ("serviceWorker" in navigator) {
          const registration = await navigator.serviceWorker.getRegistration("/");
          const subscription = await registration?.pushManager.getSubscription();
          if (!stopped) setOn(Boolean(subscription));
        }
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [client]);
  if (
    !key ||
    browserPermission() === "unsupported" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in globalThis)
  )
    return null;
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
              .catch(() =>
                setError(
                  "Could not enable push. Check this browser’s notification permission and try again.",
                ),
              )
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
