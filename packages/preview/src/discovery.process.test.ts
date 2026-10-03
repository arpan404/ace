import { expect, test } from "vitest";
import { createServer } from "node:net";
import {
  discoverListeningPorts,
  parseListeningPorts,
  pollPorts,
  TerminalUrlScanner,
  loadLaunchFile,
} from "./index.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("OS listener snapshots ignore established sockets and deduplicate listeners", () => {
  expect([
    ...parseListeningPorts("p12\nn127.0.0.1:3000\nn*:3000\nn[::1]:5173\nn*:0\n", "lsof"),
  ]).toEqual([3000, 5173]);
  expect([
    ...parseListeningPorts(
      "0: 0100007F:0BB8 00000000:0000 0A\n1: 0100007F:1405 00000000:0000 01\n2: 00000000:0BB8 00000000:0000 0A",
      "proc",
    ),
  ]).toEqual([3000]);
});

test("discovery observes a real listening port", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP port");
    expect((await discoverListeningPorts()).has(address.port)).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("polling emits only changes and backs off until another listener changes", async () => {
  const controller = new AbortController();
  const scans = [
    new Set([3000]),
    new Set([3000]),
    new Set([3000]),
    new Set([5173]),
    new Set([5173]),
  ];
  const changes: unknown[] = [],
    waits: number[] = [];
  let index = 0;
  await pollPorts({
    signal: controller.signal,
    scan: async () => scans[index++] ?? new Set(),
    onChange: (change) => changes.push(change),
    onError: (error) => {
      throw error;
    },
    minDelay: 10,
    maxDelay: 40,
    wait: async (ms) => {
      waits.push(ms);
      if (index === scans.length) controller.abort();
    },
  });
  expect(changes).toEqual([
    { added: [3000], removed: [] },
    { added: [5173], removed: [3000] },
  ]);
  expect(waits).toEqual([10, 20, 40, 10, 20]);
});

test("failed polls preserve the previous snapshot and back off", async () => {
  const controller = new AbortController();
  let step = 0;
  const changes: unknown[] = [],
    errors: unknown[] = [],
    waits: number[] = [];
  await pollPorts({
    signal: controller.signal,
    minDelay: 1,
    maxDelay: 8,
    scan: async () => {
      step++;
      if (step === 2) throw new Error("probe failure");
      return new Set(step === 1 ? [3000] : [3001]);
    },
    onChange: (c) => changes.push(c),
    onError: (e) => errors.push(e),
    wait: async (ms) => {
      waits.push(ms);
      if (step === 3) controller.abort();
    },
  });
  expect(errors).toHaveLength(1);
  expect(changes.at(-1)).toEqual({ added: [3001], removed: [3000] });
  expect(waits).toEqual([1, 2, 1]);
});

test("terminal URLs survive chunk boundaries, ANSI codes and long noise", () => {
  const scanner = new TerminalUrlScanner();
  expect(scanner.feed("Ready: ht")).toEqual([]);
  expect(scanner.feed("tp://local")).toEqual([]);
  expect(scanner.feed("host:30")).toEqual([]);
  expect(scanner.feed("00/a?q=1\nhttps://[::1]:5173/\n")).toEqual([
    "http://localhost:3000/a?q=1",
    "https://[::1]:5173/",
  ]);
  expect(scanner.feed("http://evil.test/ http://localhost.evil/ ")).toEqual([]);
  expect(scanner.feed("x".repeat(65_000))).toEqual([]);
  expect(scanner.feed("\n\x1b[32mhttp://127.0.0.1:8080/\x1b[0m ")).toEqual([
    "http://127.0.0.1:8080/",
  ]);
});

test("launch configuration reads from the workspace and rejects ambiguous executables", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-preview-"));
  try {
    await mkdir(join(root, ".ace"));
    await writeFile(
      join(root, ".ace", "launch.json"),
      JSON.stringify({ configurations: [{ name: "dev", command: "node", autoPort: true }] }),
    );
    expect((await loadLaunchFile(root)).configurations[0]?.command).toBe("node");
    await writeFile(
      join(root, ".ace", "launch.json"),
      JSON.stringify({
        configurations: [{ name: "bad", command: "node", runtimeExecutable: "bun" }],
      }),
    );
    await expect(loadLaunchFile(root)).rejects.toThrow("Choose one executable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("polling detects changes when the scanner reuses and mutates its result Set", async () => {
  const ports = new Set([3000]);
  const controller = new AbortController();
  const changes: unknown[] = [];
  let waits = 0;
  await pollPorts({
    scan: async () => ports,
    signal: controller.signal,
    onChange: (change) => changes.push(change),
    onError: (error) => {
      throw error;
    },
    wait: async () => {
      waits++;
      if (waits === 1) {
        ports.clear();
        ports.add(5173);
      } else controller.abort();
    },
  });
  expect(changes).toEqual([
    { added: [3000], removed: [] },
    { added: [5173], removed: [3000] },
  ]);
});
