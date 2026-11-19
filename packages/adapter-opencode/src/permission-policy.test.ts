import { expect, test } from "vitest";
import { opencodeNative } from "@ace/provider-kit/access-modes";
import { opencodePolicy, withSpadeBot, type OpenCodeRule } from "./permission-policy.ts";

const matches = (pattern: string, value: string) =>
  new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  ).test(value);
/** OpenCode's rule evaluation: the last rule whose action and resource wildcards match wins. */
function decide(rules: readonly OpenCodeRule[], action: string, resource = "*") {
  return rules.findLast((rule) => matches(rule.action, action) && matches(rule.resource, resource))
    ?.effect;
}

test("OpenCode Ask lets ace's read-only tools run without a prompt and still asks before ace changes anything", () => {
  const rules = opencodePolicy(opencodeNative.ask).rules ?? [];
  for (const read of ["ace_context", "ace_guide", "ace_wait", "ace_tools_find", "ace_thread_read"])
    expect(decide(rules, read), read).toBe("allow");
  for (const write of ["ace_delegate", "ace_thread_start", "ace_note_add", "ace_tools_call"])
    expect(decide(rules, write), write).toBe("ask");
  expect(decide(rules, "edit", "src/index.ts")).toBe("ask");
  expect(decide(rules, "read", ".env")).toBe("ask");
});

test("a Spade bot's read-only session lets the gated bridge and ace's reads run without asking", () => {
  const policy = withSpadeBot(opencodePolicy(opencodeNative.readOnly), ["spade_call", "context"]);
  expect(policy.agent).toBe("plan");
  const rules = policy.rules ?? [];
  for (const allowed of ["ace_spade_call", "ace_context"])
    expect(decide(rules, allowed), allowed).toBe("allow");
  // Nothing else is loosened: no rule speaks for another ace tool or OpenCode's own edits.
  expect(decide(rules, "ace_delegate")).toBeUndefined();
  expect(decide(rules, "edit", "notes.md")).toBeUndefined();
  // Any other read-only session keeps the plan agent with no ace rules.
  expect(
    decide(opencodePolicy(opencodeNative.readOnly).rules ?? [], "ace_spade_call"),
  ).toBeUndefined();
});
