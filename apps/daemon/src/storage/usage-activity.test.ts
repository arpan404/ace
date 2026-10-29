import { expect, test } from "vitest";
import {
  cpuActivity,
  linuxDiskBytes,
  macDiskActivity,
  sampleUsageActivity,
  windowsDiskActivity,
  type ActivityRuntime,
} from "./usage-activity.ts";
import { usageIdle } from "./usage-schedule.ts";

test("CPU admission measures time deltas rather than boot averages or load average", () => {
  expect(cpuActivity([{ idle: 100, total: 1000 }], [{ idle: 190, total: 1100 }])).toBeCloseTo(0.1);
  expect(cpuActivity([{ idle: 100, total: 1000 }], [{ idle: 100, total: 1100 }])).toBe(1);
  expect(cpuActivity([{ idle: 100, total: 1000 }], [{ idle: 100, total: 1000 }])).toBeNull();
  expect(cpuActivity([{ idle: 100, total: 1000 }], [{ idle: 50, total: 2000 }])).toBeNull();
  expect(cpuActivity([{ idle: 100, total: 1000 }], [])).toBeNull();
});

test("macOS uses the interval sample across every reported disk", () => {
  expect(
    macDiskActivity(`disk0 disk1
KB/t tps MB/s KB/t tps MB/s
20.00 300 90.00 10.00 400 80.00
10.00 20 0.25 10.00 40 0.50`),
  ).toBe(0.75 * 1024 ** 2);
  expect(macDiskActivity("KB/t tps MB/s\n10 20 30")).toBeNull();
  expect(macDiskActivity("KB/t tps MB/s\n10 20 30\n10 20 unknown")).toBeNull();
  expect(macDiskActivity("KB/t tps MB/s\n10 20 30\n10 20 30 40")).toBeNull();
});

test("Linux adds read and write sectors and rejects incomplete or overflowing counters", () => {
  expect(
    linuxDiskBytes("8 0 sda 1 0 100 0 1 0 200 0 0 0 0\n8 1 sda1 1 0 10 0 1 0 20 0 0 0 0"),
  ).toBe(330 * 512);
  expect(linuxDiskBytes("8 0 sda 1 2")).toBeNull();
  expect(linuxDiskBytes("8 0 sda 1 0 bad 0 1 0 200 0 0 0 0")).toBeNull();
  expect(linuxDiskBytes("8 0 sda 1 0 999999999999999999 0 1 0 200 0 0 0 0")).toBeNull();
});

test("Windows accepts bounded CIM counter values without guessing absent measurements", () => {
  expect(windowsDiskActivity('{"DiskBytesPersec":"1024"}')).toBe(1024);
  expect(windowsDiskActivity('{"DiskBytesPersec":-1}')).toBeNull();
  expect(windowsDiskActivity("{}")).toBeNull();
  expect(windowsDiskActivity("no permission")).toBeNull();
  expect(windowsDiskActivity('{"DiskBytesPersec":null}')).toBeNull();
});

test("unknown or busy system activity cannot admit an automatic scan", () => {
  expect(usageIdle({ cpu: 0.1, disk: 0 })).toBe(true);
  expect(usageIdle({ cpu: null, disk: 0 })).toBe(false);
  expect(usageIdle({ cpu: 0, disk: null })).toBe(false);
  expect(usageIdle({ cpu: 0.3, disk: 0 })).toBe(false);
  expect(usageIdle({ cpu: 0, disk: 2 * 1024 ** 2 })).toBe(false);
});

test("Linux sampling uses elapsed time and a failed disk adapter reports unknown", async () => {
  let time = 0,
    reads = 0,
    cpu = 0;
  const runtime: ActivityRuntime = {
    platform: "linux",
    now: () => time,
    cpu: () => (cpu++ ? [{ total: 1100, idle: 190 }] : [{ total: 1000, idle: 100 }]),
    pause: async () => {},
    command: async () => {
      if (reads++ === 0) return "8 0 sda 1 0 100 0 1 0 200 0 0 0 0";
      time = 2000;
      return "8 0 sda 1 0 200 0 1 0 300 0 0 0 0";
    },
  };
  const activity = await sampleUsageActivity(new AbortController().signal, runtime);
  expect(activity.cpu).toBeCloseTo(0.1);
  expect(activity.disk).toBe((200 * 512) / 2);
  runtime.command = async () => {
    throw new Error("unsupported");
  };
  expect((await sampleUsageActivity(new AbortController().signal, runtime)).disk).toBeNull();
});

test("cancellation interrupts probes instead of being treated as idle", async () => {
  const controller = new AbortController();
  const runtime: ActivityRuntime = {
    platform: "linux",
    now: () => 0,
    cpu: () => [],
    pause: async () => {
      controller.abort();
      throw new Error("cancelled");
    },
    command: async () => "8 0 sda 1 0 100 0 1 0 200 0 0 0 0",
  };
  await expect(sampleUsageActivity(controller.signal, runtime)).rejects.toThrow("cancelled");
});
