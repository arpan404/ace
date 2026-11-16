import { expect, it } from "vitest";
import { hostId, keyPair } from "@ace/secure-channel";
import { ControlMessage } from "./config.ts";
import { RelayRoutes } from "./routes.ts";
import { clientPurpose, hostFeatures } from "./purpose.ts";

const host = hostId(keyPair().publicKey);
const ticket = (n: number) => n.toString(16).padStart(64, "0");
const routes = () => new RelayRoutes({ ticketTimeoutMs: 1000 });

it("a media client is offered to a host with the media feature, purpose and all", () => {
  const relay = routes();
  relay.register("h", host, true);
  expect(relay.request("c", host, ticket(1), 0, "media")).toEqual([
    { type: "offer", socket: "h", ticket: ticket(1), purpose: "media" },
  ]);
  expect(relay.request("d", host, ticket(2), 0)).toEqual([
    { type: "offer", socket: "h", ticket: ticket(2) },
  ]);
});

it("a media client is refused, unoffered, by a host without the media feature", () => {
  const relay = routes();
  relay.register("h", host);
  expect(relay.request("c", host, ticket(1), 0, "media")).toEqual([
    { type: "close", socket: "c", code: 1008, reason: "Media unavailable" },
  ]);
  // Nothing waits on the refused ticket: a join with it is invalid.
  expect(relay.join("j", ticket(1), 0)).toContainEqual(
    expect.objectContaining({ type: "close", socket: "j", reason: "Invalid ticket" }),
  );
});

it("a replaced registration takes media only if the new one says so", () => {
  const relay = routes();
  relay.register("old", host, true);
  relay.register("new", host);
  expect(relay.request("c", host, ticket(1), 0, "media")).toEqual([
    { type: "close", socket: "c", code: 1008, reason: "Media unavailable" },
  ]);
});

it("hosts restored after hibernation keep their media feature", () => {
  const relay = routes();
  relay.restore([{ socket: "h", hostId: host, media: true }], []);
  expect(relay.request("c", host, ticket(1), 0, "media")).toEqual([
    { type: "offer", socket: "h", ticket: ticket(1), purpose: "media" },
  ]);
});

it("URLs name features and purposes; an unknown purpose is invalid, not ignored", () => {
  expect([...hostFeatures(new URL("ws://r/host?features=http,media"))]).toEqual(["http", "media"]);
  expect(hostFeatures(new URL("ws://r/host")).size).toBe(0);
  expect(clientPurpose(new URL("ws://r/client?hostId=x"))).toBeUndefined();
  expect(clientPurpose(new URL("ws://r/client?purpose=media"))).toBe("media");
  expect(clientPurpose(new URL("ws://r/client?purpose=files"))).toBe("invalid");
});

it("a daemon parses a media offer and keeps a plain offer plain", () => {
  expect(ControlMessage.parse({ type: "client", ticket: ticket(1), purpose: "media" })).toEqual({
    type: "client",
    ticket: ticket(1),
    purpose: "media",
  });
  expect(() => ControlMessage.parse({ type: "client", ticket: ticket(1), purpose: "x" })).toThrow();
});
