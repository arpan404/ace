import type { ClientApi } from "@ace/client";
import type { MachineAccountStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { machineCodeAdminSource } from "./machine-code-admin-source.ts";

/** A machine's connection answering `machine.code.*` as its daemon would. */
function machine(answer: (type: string, code?: string) => unknown): Pick<ClientApi, "request"> {
  const request = async (input: { type: string; code?: string }) => ({
    type: "machine.code.result",
    requestId: "r",
    result: answer(input.type, input.code),
  });
  // Only the machine-code requests are ever sent through this stub.
  return { request: request as unknown as ClientApi["request"] };
}

const status = (set: boolean): MachineAccountStatus => ({ signedIn: true, machineCode: { set } });

test("another machine's code is read, set and cleared over its connection", async () => {
  let set = false;
  const source = machineCodeAdminSource(
    machine((type) => {
      if (type === "machine.code.set") set = true;
      if (type === "machine.code.clear") set = false;
      return { ok: true, status: status(set) };
    }),
  );
  expect((await source.status())?.machineCode.set).toBe(false);
  expect((await source.setCode("2468")).machineCode.set).toBe(true);
  expect((await source.clearCode()).machineCode.set).toBe(false);
});

test("a machine where this device isn't an admin, or without accounts, shows no code setting", async () => {
  for (const error of ["forbidden", "unavailable"])
    expect(
      await machineCodeAdminSource(machine(() => ({ ok: false, error, message: "" }))).status(),
    ).toBeUndefined();
});

test("a daemon that doesn't answer machine code requests shows no code setting", async () => {
  const silent = {
    request: (async () => {
      throw new Error("timed out");
    }) as unknown as ClientApi["request"],
  };
  expect(await machineCodeAdminSource(silent).status()).toBeUndefined();
});

test("a refused change says why in words", async () => {
  const source = machineCodeAdminSource(
    machine(() => ({ ok: false, error: "forbidden", message: "Admin only" })),
  );
  await expect(source.setCode("2468")).rejects.toThrow(
    "This device doesn't have administrator access to that machine.",
  );
  await expect(source.signIn("https://a.example", "t")).rejects.toThrow();
});
