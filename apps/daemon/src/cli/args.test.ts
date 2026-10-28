import { expect, test } from "vitest";
import { parseArgs } from "./args.ts";

test("--version and -v are switches, so they need no value", () => {
  expect(parseArgs(["--version"])).toEqual({ words: [], flags: { version: true } });
  expect(parseArgs(["-v"])).toEqual({ words: [], flags: { v: true } });
  expect(parseArgs(["version"])).toEqual({ words: ["version"], flags: {} });
  expect(() => parseArgs(["--version=1"])).toThrow("Option --version takes no value");
  // After `--`, a dash-v is prompt text again.
  expect(parseArgs(["run", "--", "-v"])).toEqual({ words: ["run", "-v"], flags: {} });
});
