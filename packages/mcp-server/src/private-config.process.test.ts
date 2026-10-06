import { chmodSync, existsSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { expect, it } from "vitest";
import { privateMcpConfig, readPrivateMcpConfig } from "./index.ts";

it("keeps credentials in private session storage outside the workspace and removes them on release", () => {
  const file = privateMcpConfig('{"bearer":"session-secret"}', process.cwd());
  const link = join(dirname(file.path), "link");
  try {
    expect(relative(process.cwd(), file.path).startsWith("..")).toBe(true);
    expect(statSync(dirname(file.path)).mode & 0o777).toBe(0o700);
    expect(statSync(file.path).mode & 0o777).toBe(0o600);
    expect(readPrivateMcpConfig(file.path)).toBe('{"bearer":"session-secret"}');
    symlinkSync(file.path, link);
    expect(() => readPrivateMcpConfig(link)).toThrow();
    chmodSync(file.path, 0o644);
    expect(() => readPrivateMcpConfig(file.path)).toThrow("Invalid private MCP");
  } finally {
    file.remove();
  }
  expect(existsSync(file.path)).toBe(false);
  file.remove();
});
