import { Notifications, type ClientApi } from "@ace/client";
import { ServerMessage } from "@ace/protocol";
import type { SuitDetail, SuitRequest, SuitSummary } from "@ace/protocol/suits";
import { expect, test } from "vitest";
import { fakeSuit } from "@/test/fake-suits.ts";
import { daemonSuitChannel, suitTransport, type SuitActive } from "./suit-transport.ts";

const base = "/v1/suits/starfield/hash-1/grant/";
const starfield: SuitDetail = {
  ...fakeSuit({ id: "starfield", dark: { canvas: "#0a0f1e" } }, { scene: true }),
  sceneUrl: `${base}scene.html`,
  assets: { "assets/star.png": `${base}assets/star.png` },
};

/** A ready client over the daemon's Suit messages, whose socket can be swapped. */
function daemon() {
  const notifications = new Notifications(64);
  const listeners = new Set<(message: ServerMessage) => void>();
  let socket = 1;
  let suits: SuitSummary[] = [starfield.summary];
  const answer = (request: SuitRequest) => {
    if (request.op === "list") return { op: "list", suits };
    if (request.op === "read") return { op: "read", suit: starfield };
    return { op: "error", code: "failed", message: "not here" };
  };
  const sent: unknown[] = [];
  const client: Pick<ClientApi, "request" | "onMessage" | "connectionGeneration" | "send"> = {
    send: (message) => void sent.push(message),
    connectionGeneration: () => notifications.select(["socket"], () => socket),
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // The client's own typing of replies is generic; what comes back is checked by the schema.
    request: (async (query: { type: string; request: SuitRequest }) =>
      ServerMessage.parse({
        type: "suitResult",
        requestId: "r",
        response: answer(query.request),
      })) as unknown as ClientApi["request"],
  };
  const push = (message: unknown) => {
    for (const listener of listeners) listener(ServerMessage.parse(message));
  };
  return {
    client,
    sent,
    push,
    swap() {
      socket++;
      notifications.emit(["socket"]);
    },
    change(next: SuitSummary[]) {
      suits = next;
      push({ type: "suitsChanged", suits });
    },
    active: (active: SuitActive) => push({ type: "suitActive", active }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the list comes on every new socket and on each change, tagged with its socket", async () => {
  const fake = daemon();
  const transport = suitTransport(daemonSuitChannel(fake.client, "http://127.0.0.1:4242/"));
  const heard: [string[], number | undefined][] = [];
  transport.watch(
    (suits, socket) => heard.push([suits.map((suit) => suit.id), socket]),
    () => {},
  );
  await settle();
  fake.swap();
  await settle();
  fake.change([]);
  expect(heard).toEqual([
    [["starfield"], 1],
    [["starfield"], 2],
    [[], 2],
  ]);
});

test("a read's scene and assets point at the daemon this page dials", async () => {
  const fake = daemon();
  const detail = await suitTransport(daemonSuitChannel(fake.client, "http://127.0.0.1:4242/")).read(
    "starfield",
  );
  expect(detail.sceneUrl).toBe(`http://127.0.0.1:4242${base}scene.html`);
  expect(detail.assets).toEqual({
    "assets/star.png": `http://127.0.0.1:4242${base}assets/star.png`,
  });
});

test("through a relay, where the daemon's HTTP is out of reach, a Suit applies with colours alone", async () => {
  const fake = daemon();
  const detail = await suitTransport(daemonSuitChannel(fake.client, undefined)).read("starfield");
  expect(detail.sceneUrl).toBeNull();
  expect(detail.assets).toEqual({});
  expect(detail.manifest.dark?.canvas).toBe("#0a0f1e");
});

test("an agent's previews and keeps reach the page as they are pushed", () => {
  const fake = daemon();
  const heard: SuitActive[] = [];
  suitTransport(daemonSuitChannel(fake.client, undefined)).watchActive((active) =>
    heard.push(active),
  );
  fake.active({ kind: "preview", suitId: "starfield" });
  fake.active({ kind: "keep", suitId: "starfield", keepId: "k1" });
  expect(heard).toEqual([
    { kind: "preview", suitId: "starfield" },
    { kind: "keep", suitId: "starfield", keepId: "k1" },
  ]);
});

test("a live check the daemon asks for reaches the page, and its report goes back as suitReport", () => {
  const fake = daemon();
  const transport = suitTransport(daemonSuitChannel(fake.client, undefined));
  const asked: unknown[] = [];
  transport.watchChecks((check) => asked.push(check));
  fake.push({ type: "suitCheck", check: { checkId: "c1", suitId: "starfield" } });
  expect(asked).toEqual([{ checkId: "c1", suitId: "starfield" }]);
  const report = {
    checkId: "c1",
    suitId: "starfield",
    client: "web" as const,
    scheme: "dark" as const,
    widths: [1280],
    problems: [],
    unchecked: [],
    screenshot: null,
  };
  expect(transport.report(report)).toBe(true);
  expect(fake.sent).toEqual([{ type: "suitReport", report }]);
});
