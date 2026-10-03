import { FakeAccess } from "@ace/fake-daemon";
import { expect, test } from "vitest";
import { unavailableGaps } from "./access-gaps.ts";
import { accessOrigin, accessSource } from "./access-source.ts";

const token = "ace0".repeat(16);
const endpoint = (fetch: (input: string, init: RequestInit) => Promise<Response>) =>
  accessSource(
    {
      kind: "fake",
      access: { origin: "http://127.0.0.1:4242/", fetch, token: async () => token },
      devices: () => {
        throw new Error("unused");
      },
    },
    unavailableGaps(),
  );

test("the daemon's access routes live on the same host and port as its socket", () => {
  expect(accessOrigin("ws://127.0.0.1:4242/")).toBe("http://127.0.0.1:4242/");
  expect(accessOrigin("wss://studio-mac.tailnet.ts.net:7417/")).toBe(
    "https://studio-mac.tailnet.ts.net:7417/",
  );
});

test("pairing while remote access is off says how to turn it on", async () => {
  const access = endpoint(async () => new Response("{}", { status: 409 }));

  await expect(access.pair(["read"])).rejects.toThrow(/ACE_LISTEN=lan or ACE_LISTEN=tailscale/);
});

test("a paired device's token can't manage pairing, and the page says why", async () => {
  const access = endpoint(async () => new Response("{}", { status: 403 }));

  await expect(access.devices()).rejects.toThrow("Only the daemon's own token");
});

test("a pairing carries the one-time code from its link, for typing by hand", async () => {
  const daemon = new FakeAccess(() => 5_000);
  const access = endpoint(daemon.fetch);

  const pairing = await access.pair(["read", "operate"]);

  expect(pairing.url).toContain(`code=${pairing.code}`);
  expect(pairing.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(pairing.expiresAt).toBe(5_000 + 10 * 60_000);
});

test("the desktop app's own browser credential isn't listed as a paired device", async () => {
  const listed = [
    {
      id: "phone",
      name: "Pixel",
      scopes: ["read", "operate"],
      createdAt: 1,
      lastSeenAt: 2,
      revokedAt: null,
    },
    {
      id: "desk",
      name: "ace desktop browser",
      scopes: ["desktop"],
      createdAt: 1,
      lastSeenAt: 2,
      revokedAt: null,
    },
    { id: "old", name: "Old phone", scopes: ["read"], createdAt: 1, lastSeenAt: 2, revokedAt: 3 },
  ];
  const access = endpoint(async () => new Response(JSON.stringify(listed), { status: 200 }));

  expect((await access.devices()).map((device) => device.name)).toEqual(["Pixel"]);
});
