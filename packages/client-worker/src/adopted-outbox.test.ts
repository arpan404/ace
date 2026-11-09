import { expect, test } from "vitest";
import type { Storage } from "@ace/client";
import { adoptedOutbox } from "./adopted-outbox.ts";

const send = (id: string, hostId = "host") =>
  JSON.stringify({ command: { id, deviceId: "browser-paired" }, hostId, state: "pending" });

/** A paired worker's outbox: one record per send, bound to its daemon. */
function pairingOutbox(records: Map<string, string>, bound = "host"): Storage {
  return {
    hostBinding: { load: async () => bound, save: async () => {} },
    records: {
      load: async () => [...records.values()],
      write: async (id, value) => {
        if (value === null) records.delete(id);
        else records.set(id, value);
      },
    },
    load: async () => null,
    save: async () => {},
  };
}

test("a send an interrupted adoption already saved leaves the pairing's outbox on the next run, kept once", async () => {
  // The account outbox saved the send, then the app stopped before the pairing's copy went.
  let saved: string | null = JSON.stringify([JSON.parse(send("copied"))]);
  const own = { load: async () => saved, save: async (value: string) => void (saved = value) };
  const pairing = new Map([
    ["copied", send("copied")],
    ["other-daemon", send("other-daemon", "elsewhere")],
  ]);

  const outbox = adoptedOutbox(own, pairingOutbox(pairing), "host");
  const loaded = JSON.parse((await outbox.load()) ?? "[]") as { command: { id: string } }[];

  expect(loaded.map((entry) => entry.command.id)).toEqual(["copied"]);
  // Without any save: the copy goes, another daemon's send stays.
  expect([...pairing.keys()]).toEqual(["other-daemon"]);
});

test("a send the account outbox doesn't hold yet stays in the pairing's outbox until the account outbox saves it", async () => {
  let saved: string | null = null;
  const own = { load: async () => saved, save: async (value: string) => void (saved = value) };
  const pairing = new Map([["queued", send("queued")]]);
  const outbox = adoptedOutbox(own, pairingOutbox(pairing), "host");

  const loaded = await outbox.load();
  expect([...pairing.keys()]).toEqual(["queued"]);
  await outbox.save(loaded ?? "[]");
  expect([...pairing.keys()]).toEqual([]);
  expect(saved).toContain("queued");
});
