self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const rawDeepLink = event.notification.data && event.notification.data.deepLink;
  const deepLink = typeof rawDeepLink === "string" && rawDeepLink.length > 0 ? rawDeepLink : "/";
  const targetUrl = new URL(deepLink, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        includeUncontrolled: true,
        type: "window",
      });

      for (const client of windows) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            await client.navigate(targetUrl);
          }
          return;
        }
      }

      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl);
      }
    })(),
  );
});
