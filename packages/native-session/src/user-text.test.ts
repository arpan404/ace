import { expect, test } from "vitest";
import { sanitizeUserText } from "./index.ts";

test.each([
  ["<system-reminder>Plan instructions</system-reminder>Fix retry", "Fix retry"],
  ["Fix retry<system-reminder>Plan instructions", "Fix retry"],
  ["<environment_context>private context", ""],
  [
    "Fix <system-reminder>outer<system-reminder>nested</system-reminder>outer</system-reminder>retry",
    "Fix retry",
  ],
  ["<command-args>Fix retry</command-args>", "Fix retry"],
  ["Please explain <example>XML</example>", "Please explain <example>XML</example>"],
])("injected envelopes are hidden without removing the request: %s", (input, shown) => {
  expect(sanitizeUserText(input)).toBe(shown);
});
