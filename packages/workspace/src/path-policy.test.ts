import { describe, expect, test } from "vitest";
import { validRelativePath } from "./safety.ts";

describe("posix baseline stays identical", () => {
  test("allows posix-legal names that win32 forbids", () => {
    expect(validRelativePath("a:b", "darwin")).toBe(true);
    expect(validRelativePath("CON", "darwin")).toBe(true);
    expect(validRelativePath("NUL.txt", "darwin")).toBe(true);
    expect(validRelativePath("a.", "darwin")).toBe(true);
    expect(validRelativePath("a ", "darwin")).toBe(true);
    expect(validRelativePath("a*b?a", "darwin")).toBe(true);
    expect(validRelativePath("line\nbreak.log", "darwin")).toBe(true);
  });

  test("keeps base rejections on posix", () => {
    expect(validRelativePath("../secret", "darwin")).toBe(false);
    expect(validRelativePath("x/../a", "darwin")).toBe(false);
    expect(validRelativePath("/tmp/secret", "darwin")).toBe(false);
    expect(validRelativePath("C:/secret", "darwin")).toBe(false);
    expect(validRelativePath("a\0b", "darwin")).toBe(false);
    expect(validRelativePath("a\\b", "darwin")).toBe(false);
  });
});

describe("win32 lexical policy", () => {
  test("rejects ADS colon and drive-relative input", () => {
    expect(validRelativePath("file.txt:stream", "win32")).toBe(false);
    expect(validRelativePath("a:b", "win32")).toBe(false);
    expect(validRelativePath("C:foo", "win32")).toBe(false);
    expect(validRelativePath("C:", "win32")).toBe(false);
    expect(validRelativePath("c:bar/baz", "win32")).toBe(false);
    expect(validRelativePath("C:/secret", "win32")).toBe(false);
  });

  test("rejects device prefixes", () => {
    expect(validRelativePath("//./C:/foo", "win32")).toBe(false);
    expect(validRelativePath("//?/C:/foo", "win32")).toBe(false);
    expect(validRelativePath("/??/C:/foo", "win32")).toBe(false);
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
      expect(validRelativePath(name, "win32")).toBe(false);
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
      expect(validRelativePath(name, "win32")).toBe(false);
    }
  });

  test("keeps Unicode whitespace before the dot valid", () => {
    expect(validRelativePath("CON\u00A0.txt", "win32")).toBe(true);
    expect(validRelativePath("my\u00A0file.txt", "win32")).toBe(true);
  });

  test("keeps near-miss device names valid", () => {
    expect(validRelativePath("myCON.txt", "win32")).toBe(true);
    expect(validRelativePath("CONa", "win32")).toBe(true);
    expect(validRelativePath("a/CONa/b", "win32")).toBe(true);
  });

  test("rejects forbidden and control characters", () => {
    for (const name of ["a<b", "a>b", 'a"b', "a|b", "a?b", "a*b", "a\x01b", "line\nbreak.log"]) {
      expect(validRelativePath(name, "win32")).toBe(false);
    }
  });

  test("rejects trailing dot or space per component", () => {
    expect(validRelativePath("a.", "win32")).toBe(false);
    expect(validRelativePath("a ", "win32")).toBe(false);
    expect(validRelativePath("a/b.", "win32")).toBe(false);
    expect(validRelativePath("a/b ", "win32")).toBe(false);
    expect(validRelativePath("...", "win32")).toBe(false);
  });

  test("preserves unicode and root/dot/slash normalization", () => {
    expect(validRelativePath("", "win32")).toBe(true);
    expect(validRelativePath(".", "win32")).toBe(true);
    expect(validRelativePath("a/./b", "win32")).toBe(true);
    expect(validRelativePath("a//b", "win32")).toBe(true);
    expect(validRelativePath("a/b/", "win32")).toBe(true);
    expect(validRelativePath("café-日本語-🎉.txt", "win32")).toBe(true);
    expect(validRelativePath(".temp", "win32")).toBe(true);
  });
});
