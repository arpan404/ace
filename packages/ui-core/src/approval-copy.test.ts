import type { InteractionRequest } from "@ace/protocol";
import { expect, test } from "vitest";
import { approvalCopy } from "./approval-copy.ts";

type ApprovalRequest = Extract<InteractionRequest, { kind: "approval" }>;

const appRequest = (bundleId: string): ApprovalRequest => ({
  kind: "approval",
  title: `Use ${bundleId}`,
  description: "Check the totals in the open document",
  target: {
    tool: "screen_request_app",
    access: "execute",
    origin: "ace",
    riskClass: "external-effect",
    input: { bundleId, kind: "app" },
  },
  options: [
    { id: "allow_once", kind: "allow_once", label: "Allow once" },
    { id: "allow_thread", kind: "allow_session", label: "Allow for this thread" },
    { id: "allow_always", kind: "allow_always", label: "Always" },
    { id: "deny", kind: "deny", label: "Deny" },
  ],
  defaultToNo: true,
});

const emphasis = (request: ApprovalRequest) =>
  approvalCopy(request).choices.map((choice) => `${choice.label}:${choice.emphasis}`);

test("an app request names the app, keeps the agent's reason and offers every scope without a primary yes", () => {
  const copy = approvalCopy(appRequest("com.apple.TextEdit"));

  expect(copy.title).toBe("Let an agent use TextEdit");
  expect(copy.reason).toBe("Check the totals in the open document");
  expect(copy.facts).toEqual([{ label: "App", value: "com.apple.TextEdit", code: true }]);
  expect(emphasis(appRequest("com.apple.TextEdit"))).toEqual([
    "Allow this turn:secondary",
    "Allow for this thread:secondary",
    "Always allow:secondary",
    "Deny:quiet",
  ]);
});

test("a sensitive app is high risk and says a saved grant still asks each turn", () => {
  const copy = approvalCopy(appRequest("com.agilebits.onepassword7"));

  expect(copy.risk?.level).toBe("high");
  expect(copy.risk?.text).toMatch(/asks again every turn/);
  expect(copy.choices.find((choice) => choice.option.id === "allow_always")?.label).toBe(
    "Allow, ask each turn",
  );
});

test("a request that doesn't default to no makes its first yes the primary button", () => {
  const request = { ...appRequest("com.apple.calculator"), defaultToNo: false };

  expect(emphasis(request)).toEqual([
    "Allow this turn:primary",
    "Allow for this thread:secondary",
    "Always allow:secondary",
    "Deny:quiet",
  ]);
});

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
  expect(copy.choices.map((choice) => choice.label)).toEqual([
    "Run once",
    "Allow read-only scripts on shop.example",
    "Deny",
  ]);
});

test("an upload from outside the project lists the exact files and counts the rest", () => {
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
  expect(copy.facts.map((fact) => fact.value)).toEqual([...paths.slice(0, 6), "and 2 more"]);
});

test("a provider's own approval keeps its title and labels", () => {
  const copy = approvalCopy({
    kind: "approval",
    title: "Run npm install",
    description: "Installs dependencies",
    target: { tool: "Bash", access: "execute", command: "npm install" },
    options: [
      { id: "yes", kind: "allow_once", label: "Yes" },
      { id: "no", kind: "deny", label: "No" },
    ],
  });

  expect(copy.tool).toBeUndefined();
  expect(copy.title).toBe("Run npm install");
  expect(copy.risk).toBeUndefined();
  expect(copy.choices.map((choice) => `${choice.label}:${choice.emphasis}`)).toEqual([
    "Yes:primary",
    "No:quiet",
  ]);
});

test("ace's tools and default-to-no requests are answered on their card, not by a one-tap approve", async () => {
  const { deliberateApproval } = await import("./approval-copy.ts");
  expect(deliberateApproval(appRequest("com.apple.TextEdit"))).toBe(true);
  expect(
    deliberateApproval({
      kind: "approval",
      title: "Run tests",
      options: [{ id: "yes", kind: "allow_once", label: "Yes" }],
    }),
  ).toBe(false);
});
