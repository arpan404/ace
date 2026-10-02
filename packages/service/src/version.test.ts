import { expect, test } from "vitest";
import { isNewer } from "./index.ts";
test.each([
  ["1.0.0-preview.2", "1.0.0-preview.1", true],
  ["1.0.0-preview.10", "1.0.0-preview.2", true],
  ["1.0.0-preview.1", "1.0.0-preview.2", false],
  ["1.0.0-beta", "1.0.0-alpha", true],
  ["1.0.0-alpha.1", "1.0.0-alpha", true],
  ["1.0.0-1", "1.0.0-alpha", false],
  ["1.0.0", "1.0.0-preview.2", true],
  ["1.0.0-preview.2", "1.0.0", false],
  ["1.0.0-preview.2", "1.0.0-preview.2", false],
  ["1.0.0", "1.0.0", false],
  ["1.0.1-preview.1", "1.0.0", true],
  ["9007199254740993.0.0", "9007199254740992.0.0", true],
])("version %s compared with %s permits update=%s", (next, current, expected) => {
  expect(isNewer(next, current)).toBe(expected);
});
