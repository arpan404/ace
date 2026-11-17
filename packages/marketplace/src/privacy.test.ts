import { expect, test } from "vitest";
import { privacySpans } from "./privacy.ts";

const context = { names: ["Arlo Quint", "arloq"] };
const found = (text: string) =>
  privacySpans(text, context).map((span) => [
    span.kind,
    span.text,
    text.slice(span.start, span.end),
  ]);

test.each([
  ["home-path", "Read /Users/arloq/Documents/plan.md first.", "/Users/arloq/Documents/plan.md"],
  ["home-path", "Logs are in /home/ops/logs today.", "/home/ops/logs"],
  ["home-path", "Open C:\\Users\\Ops\\notes.txt now.", "C:\\Users\\Ops\\notes.txt"],
  ["email", "Write to team.lead+inbox@example.co.uk about it.", "team.lead+inbox@example.co.uk"],
  ["phone", "Call +1 415-555-0172 when it breaks.", "+1 415-555-0172"],
  ["phone", "Or (020) 7946 0958 in London.", "(020) 7946 0958"],
  [
    "private-url",
    "Post to http://192.168.1.20:8080/hook each day.",
    "http://192.168.1.20:8080/hook",
  ],
  [
    "private-url",
    "Check https://wiki.corp.internal/runbook first.",
    "https://wiki.corp.internal/runbook",
  ],
  ["private-url", "The NAS is at http://nas.local/share.", "http://nas.local/share"],
  ["private-url", "Ping 10.0.4.7 before the backup.", "10.0.4.7"],
  ["own-name", "Sign replies as Arlo Quint.", "Arlo Quint"],
  ["own-name", "Ask ARLOQ before merging.", "ARLOQ"],
  [
    "secret",
    "Use ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789 to push.",
    "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
  ],
] as const)("flags %s in %j", (kind, text, span) => {
  expect(found(text)).toContainEqual([kind, span, span]);
});

test("ordinary instructions, public addresses, times and dates are not flagged", () => {
  const plain =
    "Every weekday at 8:00, sort the inbox, then read https://docs.example.com/guide and " +
    "the release from 2026-11-17. Reply within 24 hours; version 1.2.30 is fine.";
  expect(privacySpans(plain, context)).toEqual([]);
});

test("a short name never flags words that merely contain it", () => {
  expect(privacySpans("Arrange the alarms.", { names: ["Al", "ar"] })).toEqual([]);
  expect(privacySpans("Ask Al first.", { names: ["Al Rivera"] })).toEqual([]);
});

test("spans are in order and never overlap", () => {
  const spans = privacySpans("Mail arloq@example.com from /Users/arloq/x", context);
  const kinds = spans.map((span) => span.kind);
  expect(kinds).toEqual(["email", "home-path"]);
  for (const [index, span] of spans.entries())
    if (index > 0) expect(span.start).toBeGreaterThanOrEqual(spans[index - 1]?.end ?? 0);
});
