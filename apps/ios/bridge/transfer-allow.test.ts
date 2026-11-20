import "./test-host.ts";
import { CommandId, DeviceId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { answerFleet, type NativeFleetRequest } from "./fleet-admin.ts";
import { until } from "./sheet-fixture.ts";
import { forecast, linkedMac, phoneOn } from "./transfer-fixture.ts";

/*
 * Allow projects from Continue on (ADR 0101): a linked machine that doesn't take projects from
 * this one says why, and the phone, paired with that machine too, allows them there through
 * that machine's own runtime, then goes on to the options.
 */

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function linked() {
  const app = linkedMac();
  closers.push(app.close);
  await app.start();
  // The phone's runtime for the old laptop.
  const there = phoneOn(app.laptop);
  closers.push(() => there.close());
  await there.start();
  await until(() => there.connectionState().getSnapshot() === "ready", "the laptop");
  const ask = (request: NativeFleetRequest["request"]) =>
    answerFleet(there, { type: "native.fleet", machine: "Old laptop", request }) as Promise<
      Record<string, unknown>
    >;
  return { app, ask };
}

const allowStep = (step: Record<string, unknown> | undefined) =>
  step as { machine: { deviceId: string }; action: string; unreached: string } | undefined;

test("choosing a machine that doesn't take projects says why and allows them there, then offers the options", async () => {
  const { app, ask } = await linked();
  app.act({ kind: "open", subject: forecast });
  await app.sheetAt("machines");
  app.act({ kind: "choose", hostId: "laptop", sender: "MacBook" });
  const step = allowStep(await app.sheetAt("allow"));
  expect(step?.action).toBe("Allow projects on Old laptop");
  expect(step?.unreached).toBe(
    "Old laptop doesn't take projects from MacBook yet; allow them on Old laptop in Settings › Fleet.",
  );
  const deviceId = String(step?.machine.deviceId);

  expect(
    await ask({ op: "allowOffer", deviceId: DeviceId.parse(deviceId), sender: "MacBook" }),
  ).toEqual({
    ok: true,
    offer: "allow",
    words: "Old laptop doesn't take projects from MacBook yet.",
  });
  expect(
    await ask({
      op: "scope",
      commandId: CommandId.parse("allow-1"),
      deviceId: DeviceId.parse(deviceId),
      allowed: true,
    }),
  ).toEqual({ ok: true });
  expect(
    (await ask({ op: "allowOffer", deviceId: DeviceId.parse(deviceId), sender: "MacBook" })).offer,
  ).toBe("held");

  app.act({ kind: "allowed" });
  expect(await app.sheetAt("options")).toMatchObject({ action: "Continue on Old laptop" });
  // Read again, the laptop takes work from here now.
  await until(
    () =>
      (app.machines()?.machines as { hostId: string; reason: string | null }[] | undefined)?.find(
        (each) => each.hostId === "laptop",
      )?.reason === null,
    "the laptop allowed",
  );
});

test("a machine whose ace can't change a link in place says to update it there", async () => {
  const { app, ask } = await linked();
  app.laptop.refuseRequests("invalid_message", "fleet.request");
  expect(
    await ask({
      op: "scope",
      commandId: CommandId.parse("allow-old"),
      deviceId: DeviceId.parse("fleet-this-mac-on-laptop"),
      allowed: true,
    }),
  ).toEqual({
    ok: false,
    code: "invalid_message",
    message:
      "Old laptop runs an older ace that can't allow projects from here. Update ace there, or unlink and link them again in Settings › Fleet.",
  });
});

test("Linked machines says which machines take this one's projects", async () => {
  const { app } = await linked();
  const overview = (await answerFleet(app.client, {
    type: "native.fleet",
    machine: "MacBook",
    request: { op: "overview" },
  })) as { links: { hostId: string; projects: boolean | null; projectsLine: string | null }[] };
  const line = (hostId: string) => overview.links.find((each) => each.hostId === hostId);
  expect(line("build")).toMatchObject({
    projects: true,
    projectsLine: "MacBook can continue threads and open projects there.",
  });
  expect(line("laptop")).toMatchObject({
    projects: false,
    projectsLine: "Old laptop doesn't take projects from MacBook.",
  });
});
