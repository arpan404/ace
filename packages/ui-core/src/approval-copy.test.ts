import { expect, test } from "vitest";
import { approvalCopy } from "./approval-copy.ts";

test("a read-only page script shows its code, its page and the site-wide read-only choice", () => {
  const copy = approvalCopy({
    kind: "approval",
    title: "Browser evaluate approval",
    description: "evaluate on https://shop.example (read-only)",
    target: {
      tool: "browser.evaluate",
      origin: "ace",
      access: "read",
      input: {
        origin: "https://shop.example",
        url: "https://shop.example/cart",
        mode: "read-only",
        expression: "document.title",
      },
    },
    options: [
      { id: "allow_once", kind: "allow_once", label: "Allow once" },
      { id: "allow_site", kind: "allow_session", label: "Allow read-only JS for this site" },
      { id: "deny", kind: "deny", label: "Deny" },
    ],
    defaultToNo: true,
  });

  expect(copy.title).toBe("Run a script on shop.example");
  expect(copy.code).toBe("document.title");
  expect(copy.risk?.text).toMatch(/^Read-only/);
  expect(copy.facts.map((fact) => fact.value)).toEqual(["https://shop.example/cart", "Read only"]);
  expect(copy.decisions.map((decision) => [decision.label, decision.scope])).toEqual([
    ["Allow once", undefined],
    ["Always allow", "Allow read-only scripts on shop.example"],
    ["Deny", undefined],
  ]);
});

test("an upload from outside the project lists every file it would hand over, however many", () => {
  const paths = Array.from({ length: 8 }, (_, index) => `/Users/me/Documents/file-${index}.pdf`);
  const copy = approvalCopy({
    kind: "approval",
    title: "Browser upload approval",
    target: { tool: "browser.upload", origin: "ace", access: "execute", input: { paths } },
    options: [
      { id: "allow_once", kind: "allow_once", label: "Allow once" },
      { id: "deny", kind: "deny", label: "Deny" },
    ],
    defaultToNo: true,
  });

  expect(copy.risk?.level).toBe("high");
  // The seventh and eighth files are named too: approving uploads all of them.
  expect(copy.files).toEqual(paths);
  expect(copy.facts).toEqual([{ label: "Files", value: "8", code: false }]);
});

test("a provider's own approval answers in the same verbs, whatever the provider calls them", () => {
  const copy = approvalCopy({
    kind: "approval",
    title: "Run npm install",
    description: "Installs dependencies",
    target: { tool: "Bash", access: "execute", command: "npm install" },
    options: [
      { id: "yes", kind: "allow_once", label: "Yes" },
      { id: "always", kind: "allow_always", label: "Yes, and don't ask again for npm install" },
      { id: "no", kind: "deny", label: "No" },
    ],
  });

  expect(copy.tool).toBeUndefined();
  expect(copy.title).toBe("Run npm install");
  expect(copy.decisions.map((decision) => `${decision.label}:${decision.emphasis}`)).toEqual([
    "Allow once:primary",
    "Always allow:quiet",
    "Deny:quiet",
  ]);
  expect(copy.decisions[1]?.scope).toBe("Yes, and don't ask again for npm install");
  expect(copy.reason).toBe("Installs dependencies");
});

test("a shell request shows its command once: in its block, not again in the heading", () => {
  const copy = approvalCopy(
    {
      kind: "approval",
      title: "Run bun install --frozen-lockfile?",
      options: [
        { id: "once", kind: "allow_once", label: "Approve once" },
        { id: "deny", kind: "deny", label: "Decline" },
      ],
    },
    { command: "bun install --frozen-lockfile" },
  );

  expect(copy.command).toBe("bun install --frozen-lockfile");
  expect(copy.heading).toBe("Run this command?");
  // The card is still named after what it runs, for a list and assistive tech.
  expect(copy.title).toBe("Run bun install --frozen-lockfile?");
  expect(copy.decisions.map((decision) => decision.label)).toEqual(["Allow once", "Deny"]);
});

test("a thread-wide grant is the Always allow where nothing wider is offered, and a cancel is kept aside", () => {
  const copy = approvalCopy({
    kind: "approval",
    title: "Allow git push to main?",
    options: [
      { id: "thread", kind: "allow_session", label: "Always allow git push in this thread" },
      { id: "once", kind: "allow_once", label: "Allow once" },
      { id: "deny", kind: "deny", label: "Deny" },
      { id: "abort", kind: "cancel", label: "Stop the turn" },
    ],
  });

  expect(copy.decisions.map((decision) => [decision.label, decision.option.id])).toEqual([
    ["Allow once", "once"],
    ["Always allow", "thread"],
    ["Deny", "deny"],
  ]);
  expect(copy.others.map((choice) => choice.label)).toEqual(["Stop the turn"]);
});

test("ace's tools and default-to-no requests are answered on their card, not by a one-tap approve", async () => {
  const { deliberateApproval } = await import("./approval-copy.ts");
  expect(
    deliberateApproval({
      kind: "approval",
      title: "Delete the release branch",
      options: [{ id: "yes", kind: "allow_once", label: "Yes" }],
      defaultToNo: true,
    }),
  ).toBe(true);
  expect(
    deliberateApproval({
      kind: "approval",
      title: "Run tests",
      options: [{ id: "yes", kind: "allow_once", label: "Yes" }],
    }),
  ).toBe(false);
});
