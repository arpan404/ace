import { expect, it } from "vitest";
import { machineCodeGate } from "./machine-code-gate.ts";

it("the machine code goes with connections only until the daemon answers it", async () => {
  let issued = 0;
  const gate = machineCodeGate(async () => `grant-${++issued}`);
  let changes = 0;
  gate.subscribe(() => changes++);
  expect(await gate.credential()).toEqual({ grant: "grant-1" });
  gate.refused("machine_code_required");
  expect(gate.asking).toBe("machine_code_required");
  gate.enter("2468");
  expect(gate.asking).toBeUndefined();
  expect(await gate.credential()).toEqual({ grant: "grant-2", machineCode: "2468" });
  gate.welcomed();
  expect(await gate.credential()).toEqual({ grant: "grant-3" });
  expect(changes).toBe(3);
});

it("a wrong code is dropped so it is never sent twice, and malformed codes are refused", async () => {
  const gate = machineCodeGate(async () => "grant");
  gate.enter("1111");
  gate.refused("machine_code_wrong");
  expect(gate.asking).toBe("machine_code_wrong");
  expect(await gate.credential()).toEqual({ grant: "grant" });
  expect(() => gate.enter("12")).toThrow();
});
