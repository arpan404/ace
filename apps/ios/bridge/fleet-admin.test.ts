import "./test-host.ts";
import { afterEach, describe, expect, test } from "vitest";
import { HostId } from "@ace/protocol";
import { answerFleet } from "./fleet-admin.ts";
import { sheetFixture, until } from "./sheet-fixture.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function machine() {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const ask = (request: Parameters<typeof answerFleet>[1]["request"]) =>
    answerFleet(client, { type: "native.fleet", machine: "studio", request }) as Promise<
      Record<string, unknown>
    >;
  return { daemon, ask };
}

describe("administering a machine from the phone", () => {
  test("a pairing link made for a view-only tablet is listed until it is cancelled", async () => {
    const { ask } = await machine();
    const made = await ask({
      op: "pair",
      access: "read",
      extras: [],
      label: "Kitchen iPad",
      ttlMs: 60 * 60_000,
      deviceTtlMs: 7 * 24 * 60 * 60_000,
    });
    expect(made).toMatchObject({ ok: true });
    expect(String(made.url)).toMatch(/^https:/);
    const listed = await ask({ op: "overview" });
    expect(listed.pairings).toEqual([
      expect.objectContaining({ label: "Kitchen iPad", line: "View only · access for 7 days" }),
    ]);
    await ask({ op: "cancelPairing", id: String(made.id) });
    expect((await ask({ op: "overview" })).pairings).toEqual([]);
  });

  test("a link redeemed on this machine shows as a linked machine until unlinked", async () => {
    const { ask } = await machine();
    const hostId = HostId.parse("laptop-host");
    const pairingUrl = "https://laptop.local:5870/pair#fingerprint=ab&code=ABCD-EFGH&scopes=read";
    expect(await ask({ op: "redeemLink", pairingUrl, hostId, name: "Laptop" })).toEqual({
      ok: true,
    });
    expect((await ask({ op: "overview" })).links).toEqual([
      expect.objectContaining({ hostId, name: "Laptop", status: "online" }),
    ]);
    await ask({ op: "unlink", hostId });
    expect((await ask({ op: "overview" })).links).toEqual([]);
  });
});
