import { describe, expect, test } from "vitest";
import { validRelativePath } from "./safety.ts";

describe.runIf(process.platform === "win32")("win32 lexical policy", () => {
  test("rejects ADS colon and drive-relative input", () => {
    expect(validRelativePath("file.txt:stream")).toBe(false);
    expect(validRelativePath("a:b")).toBe(false);
    expect(validRelativePath("C:foo")).toBe(false);
    expect(validRelativePath("C:")).toBe(false);
    expect(validRelativePath("c:bar/baz")).toBe(false);
    expect(validRelativePath("C:/secret")).toBe(false);
  });

  test("rejects device prefixes", () => {
    expect(validRelativePath("//./C:/foo")).toBe(false);
    expect(validRelativePath("//?/C:/foo")).toBe(false);
    expect(validRelativePath("/??/C:/foo")).toBe(false);
  });

  test("rejects reserved DOS devices with extensions", () => {
    for (const name of [
      "CON",
      "con",
      "PRN",
      "AUX",
      "NUL",
      "NUL.txt",
      "NUL.tar.gz",
      "COM1",
      "com9.doc",
      "LPT1",
      "lpt9.txt",
      "COM¹",
      "COM²",
      "COM³",
      "LPT¹",
      "LPT²",
      "LPT³",
      "a/CON/b",
    ]) {
      expect(validRelativePath(name)).toBe(false);
    }
  });

  test("rejects reserved names with ASCII spaces before the dot", () => {
    for (const name of [
      "CON .txt",
      "con .txt",
      "COM1 .log",
      "com9 .doc",
      "AUX .log",
      "NUL .tar.gz",
      "CON   .txt",
      "a/COM1 .log/b",
    ]) {
      expect(validRelativePath(name)).toBe(false);
    }
  });

  test("keeps Unicode whitespace before the dot valid", () => {
    expect(validRelativePath("CON\u00A0.txt")).toBe(true);
    expect(validRelativePath("my\u00A0file.txt")).toBe(true);
  });

  test("keeps near-miss device names valid", () => {
    expect(validRelativePath("myCON.txt")).toBe(true);
    expect(validRelativePath("CONa")).toBe(true);
    expect(validRelativePath("a/CONa/b")).toBe(true);
  });

  test("rejects forbidden and control characters", () => {
    for (const name of ["a<b", "a>b", 'a"b', "a|b", "a?b", "a*b", "a\x01b", "line\nbreak.log"]) {
      expect(validRelativePath(name)).toBe(false);
    }
  });

  test("rejects trailing dot or space per component", () => {
    expect(validRelativePath("a.")).toBe(false);
    expect(validRelativePath("a ")).toBe(false);
    expect(validRelativePath("a/b.")).toBe(false);
    expect(validRelativePath("a/b ")).toBe(false);
    expect(validRelativePath("...")).toBe(false);
  });

  test("preserves unicode and root/dot/slash normalization", () => {
    expect(validRelativePath("")).toBe(true);
    expect(validRelativePath(".")).toBe(true);
    expect(validRelativePath("a/./b")).toBe(true);
    expect(validRelativePath("a//b")).toBe(true);
    expect(validRelativePath("a/b/")).toBe(true);
    expect(validRelativePath("café-日本語-🎉.txt")).toBe(true);
    expect(validRelativePath(".temp")).toBe(true);
  });
});
