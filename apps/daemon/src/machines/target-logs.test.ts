import { expect, test } from "vitest";
import type { MachineAgentAccess } from "@ace/protocol";
import { target } from "./target-test-support.ts";

test("routine reads another machine repeats that are served write no line per call", async () => {
  const h = target({ value: "operate" });
  for (let call = 0; call < 5; call++) expect((await h.describe()).status).toBe(200);
  expect(h.logs).toEqual([]);
});

test("routine reads refused in a row are logged once, and again when they are served", async () => {
  const access: { value: MachineAgentAccess } = { value: "off" };
  const h = target(access);
  for (let call = 0; call < 5; call++) expect((await h.describe()).status).not.toBe(200);
  expect(h.logs).toEqual(["Machine call from another device refused"]);
  access.value = "operate";
  await h.describe();
  await h.describe();
  expect(h.logs).toEqual([
    "Machine call from another device refused",
    "Machine call from another device served again",
  ]);
});
