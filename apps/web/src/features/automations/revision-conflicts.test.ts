import { expect, test } from "vitest";
import { AutomationError } from "./automations-source.ts";
import { staleDeleteMessage, staleWriteMessage } from "./revision-conflicts.ts";

test("a translated revision refusal still asks for review before deleting", () => {
  const refusal = new AutomationError("Automation revision conflict");
  expect(staleDeleteMessage(refusal)).toMatch(/changed elsewhere.*before deleting/i);
  expect(staleWriteMessage(refusal)).toMatch(/changed elsewhere.*Reload/i);
});

test("a create-only refusal and a missing definition retain their distinct recovery advice", () => {
  expect(staleWriteMessage(new AutomationError("Automation already exists"))).toMatch(
    /recreated elsewhere/i,
  );
  expect(staleDeleteMessage(new AutomationError("Automation is missing"))).toMatch(
    /no longer exists/i,
  );
});
