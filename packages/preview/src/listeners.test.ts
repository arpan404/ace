import { expect, test } from "vitest";
import {
  joinProcListeners,
  parseLsofCwds,
  parseLsofListeners,
  parseNetstatListeners,
  parseProcessParents,
  parseProcSockets,
  scanListeningPorts,
  type ProcessIo,
} from "./detection.ts";

test("lsof listener rows name each process's ports and how they can be reached", () => {
  const table = [
    "p603",
    "f10",
    "n*:62719",
    "f14",
    "n*:62719",
    "p859",
    "f6",
    "n127.0.0.1:8317",
    "f7",
    "n[::1]:5173",
    "f8",
    "n192.168.1.20:9000",
    "pnot-a-pid",
    "n127.0.0.1:4000",
    "p900",
    "nbroken",
    "n127.0.0.1:0",
  ].join("\n");
  expect(parseLsofListeners(table)).toEqual([
    { pid: 603, port: 62719, reach: "any" },
    { pid: 859, port: 8317, reach: "loopback" },
    { pid: 859, port: 5173, reach: "loopback" },
    { pid: 859, port: 9000, reach: "other" },
  ]);
});

test("a process on loopback and on every address counts as every address", () => {
  expect(parseLsofListeners("p12\nn127.0.0.1:3000\nn*:3000\n")).toEqual([
    { pid: 12, port: 3000, reach: "any" },
  ]);
});

test("/proc listening sockets join to the processes holding their inodes", () => {
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1",
    "   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1",
    "   2: 0100007F:1405 0100007F:0BB8 01 00000000:00000000 00:00000000 00000000  1000        0 333 1",
    "   3: 1401A8C0:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 444 1",
  ].join("\n");
  const tcp6 = [
    "   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1",
    "   1: 0000000000000000FFFF00000100007F:1436 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 666 1",
  ].join("\n");
  const rows = parseProcSockets(`${tcp}\n${tcp6}`);
  // The established connection (state 01) is not a listener.
  expect(rows.map((row) => [row.port, row.reach])).toEqual([
    [3000, "loopback"],
    [8080, "any"],
    [9000, "other"],
    [5173, "loopback"],
    [5174, "loopback"],
  ]);
  const held = new Map([
    [40, new Set(["111", "555"])],
    [41, new Set(["222"])],
  ]);
  // A socket no visible process holds (another user's) is left out.
  expect(joinProcListeners(rows, held)).toEqual([
    { pid: 40, port: 3000, reach: "loopback" },
    { pid: 41, port: 8080, reach: "any" },
    { pid: 40, port: 5173, reach: "loopback" },
  ]);
});

test("process parents and working directories survive malformed rows", () => {
  expect([...parseProcessParents("    1     0\n  326     1\n garbage\n  400   326\n")]).toEqual([
    [1, 0],
    [326, 1],
    [400, 326],
  ]);
  expect([
    ...parseLsofCwds("p64980\nfcwd\nn/Users/ada/app\np64981\nfcwd\nn/tmp/other dir\npx\nn/x"),
  ]).toEqual([
    [64980, "/Users/ada/app"],
    [64981, "/tmp/other dir"],
  ]);
});

test("netstat rows name each TCP listener's process, skipping other states and protocols", () => {
  const table = [
    "Active Connections",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1020",
    "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4120",
    "  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     4120",
    "  TCP    [::1]:3000             [::]:0                 LISTENING       4121",
    "  UDP    0.0.0.0:5353           *:*                                    900",
    "  TCP    127.0.0.1:4000         0.0.0.0:0              LISTENING       x",
  ].join("\r\n");
  expect(parseNetstatListeners(table)).toEqual([
    { pid: 1020, port: 135, reach: "any" },
    { pid: 4120, port: 5173, reach: "loopback" },
    { pid: 4121, port: 3000, reach: "loopback" },
  ]);
});

const unused = () => Promise.reject(new Error("not on this platform"));
const io = (platform: NodeJS.Platform, edges: Partial<ProcessIo>): ProcessIo => ({
  platform,
  run: unused,
  readText: unused,
  list: unused,
  link: unused,
  ...edges,
});

test("one scan says every listening port and the ones the named processes hold, on each OS", async () => {
  const lsof = "p10\nn127.0.0.1:3000\np20\nn*:7777\nn[::1]:7778\n";
  const netstat =
    "  TCP    127.0.0.1:3000   0.0.0.0:0   LISTENING   10\r\n  TCP    [::]:7777   [::]:0   LISTENING   20";
  const runs: string[] = [];
  const run = (stdout: string) => async (command: string) => {
    runs.push(command);
    return { stdout, code: 0 };
  };
  expect(await scanListeningPorts([20], io("darwin", { run: run(lsof) }))).toEqual({
    listening: new Set([3000, 7777, 7778]),
    owned: new Set([7777, 7778]),
  });
  expect(await scanListeningPorts([20], io("win32", { run: run(netstat) }))).toEqual({
    listening: new Set([3000, 7777]),
    owned: new Set([7777]),
  });
  // One process run per scan, whatever the number of processes asked about.
  expect(runs).toEqual(["lsof", "netstat"]);
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111",
    "   1: 0100007F:1E61 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222",
  ].join("\n");
  const listed: string[] = [];
  const linux = io("linux", {
    readText: async (path) => (path === "/proc/net/tcp" ? tcp : ""),
    list: async (path) => {
      listed.push(path);
      return ["3", "4"];
    },
    link: async (path) => (path.endsWith("/3") ? "socket:[222]" : "/dev/null"),
  });
  expect(await scanListeningPorts([20], linux)).toEqual({
    listening: new Set([3000, 7777]),
    owned: new Set([7777]),
  });
  // Only the named processes' descriptors are read.
  expect(listed).toEqual(["/proc/20/fd"]);
});

test("a failed table read fails the scan rather than answering with nothing", async () => {
  await expect(
    scanListeningPorts([1], io("darwin", { run: async () => ({ stdout: "", code: 2 }) })),
  ).rejects.toThrow();
  await expect(scanListeningPorts([1], io("linux", {}))).rejects.toThrow();
});
