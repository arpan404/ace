import { afterEach, expect, test } from "vitest";
import { ClientError, type ClientCore } from "@ace/client";
import { machinePhone } from "./machine-page-fixture.ts";
import { MachineSoftware, type MachineSoftwareScreen } from "./machine-software.ts";

/*
 * A machine page's Software from the phone, over the real SDK and a fake machine whose update
 * runs a step at a time: what it says, starting the update and its progress, and refusals.
 */

const phones: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(phones.splice(0).map((phone) => phone.close()));
});

async function open(scopes?: Parameters<typeof machinePhone>[0]) {
  const phone = await machinePhone(scopes);
  phones.push(phone);
  const access = scopes && !scopes.includes("admin") ? "read" : "admin";
  return {
    daemon: phone.daemon,
    read: () =>
      phone.ask<MachineSoftwareScreen>({ type: "machine.software", name: "studio", access }),
    act: (action: string, agents?: number) =>
      phone.ask<MachineSoftwareScreen>({
        type: "machine.software.act",
        name: "studio",
        access,
        action,
        ...(agents === undefined ? {} : { agents }),
      }),
  };
}

test("an available update offers Update when idle and Update now, asking first", async () => {
  const phone = await open();
  phone.daemon.machineUpdate.seed({ state: "available", available: "0.0.19", busy: 2 });
  const page = await phone.read();
  expect(page.line).toBe("ace 0.0.18. 0.0.19 is available.");
  expect(page.actions.map((entry) => entry.label)).toEqual(["Update when idle", "Update now"]);
  expect(page.confirm).toMatchObject({ title: "Update studio now?", agents: 2 });
  expect(page.confirm?.body).toContain("2 agents are working there");
  expect(page.updating).toBe(false);
});

test("Update now starts the update, and its progress and result show as it runs", async () => {
  const phone = await open();
  phone.daemon.machineUpdate.seed({ state: "available", available: "0.0.19", busy: 0 });
  const started = await phone.act("now", 0);
  expect(started.problem).toBeNull();
  expect(started.updating).toBe(true);
  expect(started.actions.map((entry) => entry.action)).toEqual(["cancel"]);
  while (phone.daemon.machineUpdate.step()) {
    const during = await phone.read();
    if (!during.updating) break;
    expect(during.progress).not.toBeNull();
  }
  const after = await phone.read();
  expect(after.updating).toBe(false);
  expect(after.progressTone).toBe("on");
  expect(after.line).toContain("0.0.19");
});

test("a failed update says why and offers Try again", async () => {
  const phone = await open();
  phone.daemon.machineUpdate.seed(
    { state: "available", available: "0.0.19", busy: 0 },
    { fails: "The download was interrupted" },
  );
  await phone.act("idle");
  while (phone.daemon.machineUpdate.step()) {
    if ((await phone.read()).progressTone === "warn") break;
  }
  const page = await phone.read();
  expect(page.progressTone).toBe("warn");
  expect(page.progress).toContain("The download was interrupted");
  expect(page.actions.map((entry) => entry.label)).toContain("Try again");
});

test("a phone that only reads the machine sees the version and why it can't update it", async () => {
  const phone = await open(["read", "operate"]);
  phone.daemon.machineUpdate.seed({ state: "available", available: "0.0.19", busy: 0 });
  const page = await phone.read();
  expect(page.actions).toEqual([]);
  expect(page.note).toContain("Pair it again as Administrator");
  const refused = await phone.act("idle");
  expect(refused.problem).toContain("can only read studio");
});

test("with nothing on offer it checks for updates", async () => {
  const phone = await open();
  const page = await phone.read();
  expect(page.actions.map((entry) => entry.label)).toEqual(["Check for updates"]);
  const checked = await phone.act("check");
  expect(checked.problem).toBeNull();
});

/** The phone's runtime, whose next `count` update reads fail the way `error` says. */
async function flaky() {
  const phone = await machinePhone();
  phones.push(phone);
  let failures: { count: number; error: () => Error } = { count: 0, error: () => new Error() };
  const request = ((message: { type: string }, options?: object) =>
    message.type === "machineUpdate.request" && failures.count-- > 0
      ? Promise.reject(failures.error())
      : phone.owner.request(message as never, options)) as ClientCore["request"];
  const software = new MachineSoftware({ request });
  const signal = new AbortController().signal;
  return {
    daemon: phone.daemon,
    fail: (count: number, error: () => Error) => (failures = { count, error }),
    read: () =>
      software.answer({ type: "machine.software", name: "studio", access: "admin" }, signal),
    act: (action: "idle" | "now") =>
      software.answer(
        { type: "machine.software.act", name: "studio", access: "admin", action, agents: 0 },
        signal,
      ),
  };
}

test("a read the machine doesn't answer mid-update keeps its last status, still updating", async () => {
  const phone = await flaky();
  phone.daemon.machineUpdate.seed({ state: "available", available: "0.0.19", busy: 0 });
  await phone.act("now");
  phone.daemon.machineUpdate.step();
  const before = await phone.read();
  expect(before.updating).toBe(true);
  // ace restarts to update: its reads time out, then find it offline.
  phone.fail(1, () => new ClientError("timeout"));
  const timedOut = await phone.read();
  expect(timedOut).toMatchObject({ updating: true, reachable: false, progress: before.progress });
  expect(timedOut.line).not.toContain("too old");
  expect(timedOut.note).toContain("Waiting for studio to answer");
  phone.fail(1, () => new ClientError("offline"));
  expect(await phone.read()).toMatchObject({ updating: true, reachable: false });
  // Back up: the result shows.
  while (phone.daemon.machineUpdate.step()) {}
  const after = await phone.read();
  expect(after).toMatchObject({ updating: false, reachable: true, progressTone: "on" });
});

test("only a daemon that refuses the request outright reads as too old to report", async () => {
  const phone = await flaky();
  phone.fail(1, () => new ClientError("timeout"));
  const unanswered = await phone.read();
  expect(unanswered.reachable).toBe(false);
  expect(unanswered.line).not.toContain("too old");
  phone.fail(1, () => new ClientError("daemon", "unknown_request"));
  const refused = await phone.read();
  expect(refused.reachable).toBe(true);
  expect(refused.line).toBe("Its ace is too old to report its version.");
});
