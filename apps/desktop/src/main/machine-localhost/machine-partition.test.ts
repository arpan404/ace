import { describe, expect, it } from "vitest";
import { machinePartition, machineProxy } from "./machine-partition.ts";

describe("a machine's partition", () => {
  it("is persistent and the same every time for one machine", () => {
    const name = machinePartition("host-a");
    expect(name).toMatch(/^persist:machine-[0-9a-f]{32}$/);
    expect(machinePartition("host-a")).toBe(name);
  });

  it("is never another machine's", () => {
    expect(machinePartition("host-a")).not.toBe(machinePartition("host-b"));
  });

  it("never names the machine's id in a directory", () => {
    expect(machinePartition("../../etc")).not.toContain("..");
  });
});

describe("a machine's proxy", () => {
  it("sends every host direct, then takes loopback back for the proxy, in that order", () => {
    expect(machineProxy(41234)).toEqual({
      proxyRules: "http://127.0.0.1:41234",
      proxyBypassRules: "*,<-loopback>",
    });
  });

  it.each([0, -1, 65536, 1.5, Number.NaN])("refuses port %s", (port) => {
    expect(() => machineProxy(port)).toThrow(RangeError);
  });
});
