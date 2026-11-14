import { afterEach, expect, test } from "vitest";
import { machinePhone } from "./machine-page-fixture.ts";
import type { MachineRenameReply } from "./machine-rename.ts";

/* Renaming a machine from its page: saved on the machine, so every device shows it. */

const phones: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(phones.splice(0).map((phone) => phone.close()));
});

test("rename saves the name on the machine itself", async () => {
  const phone = await machinePhone();
  phones.push(phone);
  const reply = await phone.ask<MachineRenameReply>({
    type: "machine.rename",
    name: "  Studio Mac  ",
  });
  expect(reply).toEqual({ ok: true, name: "Studio Mac" });
  expect(phone.daemon.displayName).toBe("Studio Mac");
  const { identity } = await phone.owner.request({ type: "host.identity" });
  expect(identity.displayName).toBe("Studio Mac");
});

test("a phone paired without full access is told it can't rename, and nothing changes", async () => {
  const phone = await machinePhone(["read", "operate"]);
  phones.push(phone);
  const reply = await phone.ask<MachineRenameReply>({ type: "machine.rename", name: "Other" });
  expect(reply.ok).toBe(false);
  expect(phone.daemon.displayName).toBe("studio");
});

test("an empty name is refused before anything is sent", async () => {
  const phone = await machinePhone();
  phones.push(phone);
  const reply = await phone.ask<MachineRenameReply>({ type: "machine.rename", name: "   " });
  expect(reply).toEqual({ ok: false, message: "Enter a name for the machine." });
  expect(phone.daemon.displayName).toBe("studio");
});
