import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });
afterEach(cleanup);

const day = 86_400_000;

/** The machine's page, settled: its settings and outside sections have loaded. */
async function openMachinePage() {
  const app = harness();
  await app.open("/settings/remote/primary");
  await screen.findByRole("region", { name: "Connect an app" });
  await screen.findByText("No apps connected.");
  return app;
}

const request = {
  requestId: "req-1",
  clientName: "Claude",
  domain: "claude.ai",
  scopes: ["threads:read", "threads:start", "threads:message"] as [
    "threads:read",
    "threads:start",
    "threads:message",
  ],
  matchCode: "4F7K",
  expiresAt: Date.now() + 600_000,
  redirectHost: "claude.ai",
  redirectKind: "web" as const,
};

test("approving a sign-in sends only what the person ticked, for every project, for 30 days", async () => {
  const app = await openMachinePage();
  app.daemon.outside.ask(request);
  const notice = await screen.findByText(/^Claude \(claude\.ai\) wants to use .+\. Code 4F7K\.$/);
  const line = notice.closest("[role=status]");
  if (!(line instanceof HTMLElement)) throw new Error("the notice has no line");
  await userEvent.click(within(line).getByRole("button", { name: "Review" }));

  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByLabelText("Match code 4F7K")).toBeTruthy();
  expect(within(dialog).getByText("Signs in to claude.ai")).toBeTruthy();
  // What the client asked for is marked, never ticked for the person.
  const message = within(dialog).getByRole("checkbox", { name: "Message and steer threads" });
  expect(message.getAttribute("aria-checked")).toBe("false");
  expect(within(dialog).getAllByText("asked for")).toHaveLength(2);
  await userEvent.click(within(dialog).getByRole("checkbox", { name: "Start threads" }));

  const before = Date.now();
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(app.daemon.outside.decisions).toHaveLength(1));
  const after = Date.now();
  const [sent] = app.daemon.outside.decisions;
  expect(sent?.requestId).toBe("req-1");
  const choice = sent?.choice;
  if (choice?.decision !== "approve") throw new Error("expected an approval");
  expect(choice.scopes).toEqual(["threads:read", "threads:start"]);
  expect(choice.projects).toBe("all");
  expect(choice.expiresAt).toBeGreaterThanOrEqual(before + 30 * day - 1000);
  expect(choice.expiresAt).toBeLessThanOrEqual(after + 30 * day);
  await waitFor(() => expect(screen.queryByText(/Code 4F7K/)).toBeNull());
});

test("Deny on the notice refuses the sign-in and the notice goes", async () => {
  const app = await openMachinePage();
  app.daemon.outside.ask({ ...request, domain: null });
  const notice = await screen.findByText(/^Claude wants to use .+\. Code 4F7K\.$/);
  const line = notice.closest("[role=status]");
  if (!(line instanceof HTMLElement)) throw new Error("the notice has no line");
  await userEvent.click(within(line).getByRole("button", { name: "Deny" }));
  await waitFor(() =>
    expect(app.daemon.outside.decisions).toEqual([
      { requestId: "req-1", choice: { decision: "deny" } },
    ]),
  );
  await waitFor(() => expect(screen.queryByText(/Code 4F7K/)).toBeNull());
});

test("an unverified client's review says it can't be confirmed, and a day sends a day", async () => {
  const app = await openMachinePage();
  app.daemon.outside.ask({
    ...request,
    domain: null,
    redirectHost: "cursor:",
    redirectKind: "this-device",
  });
  const notice = await screen.findByText(/Code 4F7K\.$/);
  const line = notice.closest("[role=status]");
  if (!(line instanceof HTMLElement)) throw new Error("the notice has no line");
  await userEvent.click(within(line).getByRole("button", { name: "Review" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/unverified, so ace can't tell who made it/)).toBeTruthy();
  // A code going to an app on this device warns instead of naming a host.
  expect(within(dialog).queryByText(/Signs in to/)).toBeNull();
  expect(within(dialog).getByText(/Approve only if you started it\./)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "A day" }));
  const before = Date.now();
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(app.daemon.outside.decisions).toHaveLength(1));
  const choice = app.daemon.outside.decisions[0]?.choice;
  if (choice?.decision !== "approve") throw new Error("expected an approval");
  expect(choice.scopes).toEqual(["threads:read"]);
  expect(choice.expiresAt).toBeGreaterThanOrEqual(before + day - 1000);
  expect(choice.expiresAt).toBeLessThanOrEqual(Date.now() + day);
});
