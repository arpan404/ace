import { expect, test } from "vitest";
import { sanitizeTypedText, sanitizeUserText } from "./index.ts";

test.each([
  ["<system-reminder>Plan instructions</system-reminder>Fix retry", "Fix retry"],
  ["Fix retry<system-reminder>Plan instructions", "Fix retry"],
  ["<environment_context>private context", ""],
  [
    "Fix <system-reminder>outer<system-reminder>nested</system-reminder>outer</system-reminder>retry",
    "Fix retry",
  ],
  ["<command-args>Fix retry</command-args>", "Fix retry"],
  [
    "Explain <system-reminder-template>XML</system-reminder-template> and fix parsing",
    "Explain <system-reminder-template>XML</system-reminder-template> and fix parsing",
  ],
  ["Please explain <example>XML</example>", "Please explain <example>XML</example>"],
])("injected envelopes are hidden without removing the request: %s", (input, shown) => {
  expect(sanitizeUserText(input)).toBe(shown);
});

test.each([
  ["/goal ship it", "ship it", "/goal ship it"],
  [
    "[ace-origin:delegation.message_notice:ctl_1]\nResearcher says: done",
    "Researcher says: done",
    "Researcher says: done",
  ],
  ["<system-reminder>Plan</system-reminder>/review the diff", "the diff", "/review the diff"],
  ["Fix retry [Image 1]", "Fix retry", "Fix retry"],
])(
  "a transcript drops a leading command, a message on its way keeps it, and both hide what only the agent reads: %s",
  (input, transcript, typed) => {
    expect(sanitizeUserText(input)).toBe(transcript);
    expect(sanitizeTypedText(input)).toBe(typed);
  },
);
