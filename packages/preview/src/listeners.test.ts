import { expect, test } from "vitest";
import {
  joinProcListeners,
  parseLsofCwds,
  parseLsofListeners,
  parseProcessParents,
  parseProcSockets,
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
