import { Client } from "@ace/client";
import { ClientProvider } from "@ace/client-react";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId } from "@ace/protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ArtifactImage } from "./artifact-image.tsx";

const clients: Client[] = [];
beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:screenshot");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.restoreAllMocks();
});

/** A connection whose artifact downloads answer with three bytes; only that read is faked. */
function connection() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const client = new Client({
    deviceId: DeviceId.parse("reader"),
    transport: () => fakeTransport(daemon),
    credential: async () => daemon.token,
    storage: { load: async () => null, save: async () => {} },
    scheduler: { set: () => () => {} },
    random: () => 0.5,
    id: () => "read",
  });
  clients.push(client);
  const reads = vi.spyOn(client, "downloadFile").mockImplementation(async function* () {
    yield new Uint8Array([1, 2, 3]);
  });
  return { client, reads };
}

const source = {
  kind: "artifact",
  threadId: "thread",
  artifactId: "shot",
  bytes: 3,
  mimeType: "image/png",
} as const;
const name = "Screenshot.png";

/** The browser decodes the picture at its own size. */
function decode(image: HTMLImageElement, width: number, height: number) {
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(image);
}

test("a screenshot scrolled out of the transcript and back shows at its own size with its first paint", async () => {
  const { client, reads } = connection();
  const first = render(
    <ClientProvider client={client}>
      <ArtifactImage source={source} name={name} />
    </ClientProvider>,
  );
  decode(await screen.findByAltText<HTMLImageElement>(name), 1280, 720);
  const box = screen.getByAltText<HTMLImageElement>(name).style;
  expect(box.aspectRatio).toBe("1280 / 720");
  first.unmount();

  render(
    <ClientProvider client={client}>
      <ArtifactImage source={source} name={name} />
    </ClientProvider>,
  );
  // No waiting: the kept bytes and the size it showed at are there with the row's first render.
  const again = screen.getByAltText<HTMLImageElement>(name);
  expect(again.hidden).toBe(false);
  expect(again.style.width).toBe(box.width);
  expect(again.style.aspectRatio).toBe("1280 / 720");
  expect(reads).toHaveBeenCalledTimes(1);
});

test("a screenshot that has not shown yet holds a placeholder, never an empty image", async () => {
  const { client } = connection();
  render(
    <ClientProvider client={client}>
      <ArtifactImage source={source} name={name} />
    </ClientProvider>,
  );
  const image = await screen.findByAltText<HTMLImageElement>(name);
  // Bytes are here but the picture hasn't decoded: its size is unknown, so it stays out of
  // the layout while the placeholder keeps the room.
  expect(image.hidden).toBe(true);
  decode(image, 600, 400);
  expect(image.hidden).toBe(false);
  expect(image.style.width).toBe("min(100%, 600px, 480px)");
});
