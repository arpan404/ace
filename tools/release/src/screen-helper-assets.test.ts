import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkRustToolchain,
  crateRustVersion,
  RustToolchainError,
} from "./screen-helper-assets.ts";

describe("the Linux screen helper's Rust toolchain check", () => {
  it("reads the crate's rust-version", () => {
    const toml = readFileSync(
      new URL("../../../native/screen-helper-linux/Cargo.toml", import.meta.url),
      "utf8",
    );
    expect(crateRustVersion(toml)).toBe("1.87");
    expect(() => crateRustVersion('[package]\nname = "x"\n')).toThrow(/no rust-version/);
  });

  it("accepts the required release and anything newer", () => {
    for (const rustc of [
      "rustc 1.87.0 (17067e9ac 2025-05-09)",
      "rustc 1.91.1 (ed61e7d7e 2025-11-07)",
      "rustc 1.92.0-nightly (abc 2025-10-01)",
      "rustc 2.0.0",
    ])
      expect(() => checkRustToolchain("1.87", rustc)).not.toThrow();
  });

  it("refuses an older rustc, naming the versions and the fix", () => {
    let caught: unknown;
    try {
      checkRustToolchain("1.87", "rustc 1.86.0 (05f9846f8 2025-03-31)\n");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RustToolchainError);
    expect(caught).toMatchObject({ reason: "too-old" });
    expect((caught as Error).message).toMatch(/Rust 1\.87 or newer.*rustc 1\.86\.0.*rustup update/);
    expect(() => checkRustToolchain("1.87.2", "rustc 1.87.1")).toThrow(RustToolchainError);
  });

  it("reports a missing or unreadable rustc as missing", () => {
    expect(() => checkRustToolchain("1.87", undefined)).toThrow(/no rustc is on PATH/);
    expect(() => checkRustToolchain("1.87", "something else")).toThrow(
      expect.objectContaining({ reason: "missing" }),
    );
  });
});
