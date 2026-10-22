import { expect, it } from "vitest";
import { profileSlug } from "./fleet-links.ts";

it("a linked machine's profile name is its display name in slug form, never local or a taken one", () => {
  expect(profileSlug("Studio Mac Pro", [])).toBe("studio-mac-pro");
  expect(profileSlug("Studio", ["studio", "studio-2"])).toBe("studio-3");
  expect(profileSlug("Local", [])).toBe("local-2");
  expect(profileSlug("☁️", [])).toBe("machine");
  expect(profileSlug("x".repeat(80), [])).toMatch(/^[a-z0-9-]{1,64}$/);
});
