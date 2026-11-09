import { expect, test } from "vitest";
import { grantName } from "./approval-names.ts";

test("a standing grant names what it covers once, without the provider repeating the verb", () => {
  expect(grantName("Always allow", "Always here")).toBe("Always allow here");
  expect(grantName("Always allow", "Yes, and don't ask again for npm install")).toBe(
    "Always allow for npm install",
  );
  expect(grantName("Always allow", "Allow read-only JS for this site")).toBe(
    "Always allow read-only JS for this site",
  );
  expect(grantName("Always allow", "in this project")).toBe("Always allow in this project");
});

test("words that only restate the verb leave the verb alone", () => {
  expect(grantName("Always allow", "")).toBe("Always allow");
  expect(grantName("Always allow", "Always")).toBe("Always allow");
  expect(grantName("Always allow", "Always allow.")).toBe("Always allow");
});
