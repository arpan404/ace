import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { identifiedStats, posixStats, sameFile } from "./file-identity.ts";

function realBigStat(): BigIntStats {
  const dir = mkdtempSync(join(tmpdir(), "ace-identity-"));
  const target = join(dir, "probe");
  writeFileSync(target, "hello");
  const info = statSync(target, { bigint: true });
  rmSync(dir, { recursive: true, force: true });
  return info;
}

describe("posix identity survives precision loss", () => {
  test("adjacent huge ids stay distinct when numeric ino collides", () => {
    const dev = 9007199254740993n;
    const first = posixStats(Object.assign(realBigStat(), { dev, ino: 9007199254740995n }));
    const second = posixStats(Object.assign(realBigStat(), { dev, ino: 9007199254740996n }));
    expect(first.ino).toBe(second.ino);
    expect(first.identity).toStrictEqual({
      kind: "posix",
      dev: "9007199254740993",
      ino: "9007199254740995",
    });
    expect(sameFile(first.identity, second.identity)).toBe(false);
    expect(sameFile(first.identity, first.identity)).toBe(true);
    expect(
      sameFile(first.identity, {
        kind: "posix",
        dev: "9007199254740994",
        ino: "9007199254740995",
      }),
    ).toBe(false);
  });
});

describe("win32 identity separates volumes", () => {
  test("same file id on different volumes stays distinct", () => {
    const left = identifiedStats(realBigStat(), {
      kind: "win32",
      vol: "0123456789abcdef",
      id: "0123456789abcdef0123456789abcdef",
    });
    const right = identifiedStats(realBigStat(), {
      kind: "win32",
      vol: "fedcba9876543210",
      id: "0123456789abcdef0123456789abcdef",
    });
    expect(sameFile(left.identity, right.identity)).toBe(false);
    expect(sameFile(left.identity, left.identity)).toBe(true);
    expect(
      sameFile(left.identity, {
        kind: "win32",
        vol: "0123456789abcdef",
        id: "1123456789abcdef0123456789abcdef",
      }),
    ).toBe(false);
  });
});

describe("bigint observations become lossless JSON stats", () => {
  test("real file converts without bigint residue and round-trips", () => {
    const converted = posixStats(realBigStat());
    expect(converted.isFile()).toBe(true);
    expect(converted.isDirectory()).toBe(false);
    expect(converted.size).toBe(5);
    const text = JSON.stringify(converted);
    const revived: unknown = JSON.parse(text);
    expect(revived).toMatchObject({ identity: converted.identity, size: 5 });
  });

  test("negative fractional-millisecond timestamps survive", () => {
    const converted = posixStats(
      Object.assign(realBigStat(), { atimeNs: -500500n, mtimeNs: -1500500n }),
    );
    expect(converted.atimeMs).toBeCloseTo(-0.5005, 10);
    expect(converted.mtimeMs).toBeCloseTo(-1.5005, 10);
  });
});
