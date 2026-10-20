import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { ClientMessage, DeviceId } from "@ace/protocol";
import { memoryStorage } from "@/boot/client.ts";
import { PrAvatar } from "./pr-presentation.tsx";

const ref = "c".repeat(64);
const png = "iVBORw0KGgo=";

/** A client whose daemon relays one known avatar and has none for anyone else. */
function relayingClient(known: string) {
  const daemon = new FakeDaemon({ clock: () => 1_000 });
  const asked: string[] = [];
  let ids = 0;
  return {
    asked,
    client: new Client({
      deviceId: DeviceId.parse("avatar-device"),
      credential: async () => daemon.token,
      storage: memoryStorage(),
      id: () => `avatar-${++ids}`,
      random: () => 0.5,
      scheduler: {
        set(delay, callback) {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      },
      transport: () => {
        const transport = fakeTransport(daemon);
        let reply: ((text: string) => void) | undefined;
        return {
          ...transport,
          open(events) {
            reply = events.message;
            transport.open(events);
          },
          send(text) {
            const message = ClientMessage.parse(JSON.parse(text));
            if (message.type === "avatars.resolve") {
              asked.push(...message.urls);
              reply?.(
                JSON.stringify({
                  type: "avatars.resolve",
                  requestId: message.requestId,
                  icons: message.urls.map((url) =>
                    url === known ? { state: "found", ref } : { state: "none" },
                  ),
                }),
              );
            } else if (message.type === "icons.read")
              reply?.(
                JSON.stringify({
                  type: "icons.read",
                  requestId: message.requestId,
                  ref: message.ref,
                  mimeType: "image/png",
                  data: png,
                }),
              );
            else transport.send(text);
          },
        };
      },
    }),
  };
}

test("a person's avatar shows as the image the daemon relayed, never GitHub's own URL", async () => {
  const url = "https://avatars.githubusercontent.com/u/1?v=4";
  const { client, asked } = relayingClient(url);
  await client.start();
  await expect.poll(() => client.state).toBe("ready");
  render(
    <ClientProvider client={client}>
      <PrAvatar name="octocat" url={url} />
    </ClientProvider>,
  );
  const image = await screen.findByRole("img", { name: "octocat" });
  expect(image.getAttribute("src")).toBe(`data:image/png;base64,${png}`);
  expect(asked).toEqual([url]);
});

test("someone the daemon has no avatar for shows their initial", async () => {
  const { client, asked } = relayingClient("https://avatars.githubusercontent.com/u/1?v=4");
  await client.start();
  await expect.poll(() => client.state).toBe("ready");
  render(
    <ClientProvider client={client}>
      <PrAvatar name="hubot" url="https://avatars.githubusercontent.com/u/2?v=4" />
    </ClientProvider>,
  );
  await expect.poll(() => asked.length).toBe(1);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByLabelText("hubot").textContent).toBe("H");
});
