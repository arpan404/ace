import { uxAudit } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test } from "vitest";
import { answerStore } from "./answers.ts";
import { harness } from "@/test/harness.tsx";

/*
 * A request too large to send with its thread (ADR 0157): its card shows the summary and takes
 * only a decline until the whole request has loaded, then shows it whole and takes a yes.
 */

configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());
afterEach(() => answerStore.forgetAll());

async function openCard(name: string, prepare?: (app: ReturnType<typeof harness>) => void) {
  const id = `thread-ux-${name}`;
  const scenario = uxAudit().find((entry) => entry.thread.id === id);
  if (!scenario) throw new Error(`ux audit lost ${id}`);
  const app = harness();
  app.play(scenario).runUntilBlocked();
  prepare?.(app);
  await app.open(`/t/${id}`);
  const region = await screen.findByRole("region", { name: "Waiting for you" });
  const card = await within(region).findByRole("article");
  const state = () => {
    const view = app.daemon.snapshot({ kind: "thread", threadId: ThreadId.parse(id) });
    return view?.kind === "thread" ? Object.values(view.interactions)[0]?.state : undefined;
  };
  return { app, card, state };
}

test("a summarized approval takes only Deny while it loads in full", async () => {
  const { card, state } = await openCard("large-approval", (app) =>
    app.daemon.holdRequests("interaction.read"),
  );
  expect(within(card).getByRole("status").textContent).toMatch(/too large to show/);
  const allow = within(card).getByRole("button", { name: /Allow/ });
  expect(allow).toHaveProperty("disabled", true);
  await userEvent.click(allow);
  expect(state()).toBe("pending");
  await userEvent.click(within(card).getByRole("button", { name: /Deny/ }));
  await waitFor(() => expect(state()).toBe("resolved"));
});

test("once the whole request has loaded, Allow goes and the daemon accepts it", async () => {
  const { card, state } = await openCard("large-approval");
  const allow = within(card).getByRole("button", { name: /Allow/ });
  await waitFor(() => expect(allow).toHaveProperty("disabled", false));
  expect(within(card).queryByText(/too large to show/)).toBeNull();
  await userEvent.click(allow);
  // The fake daemon refuses a yes without `readWhole`, as the daemon does.
  await waitFor(() => expect(state()).toBe("resolved"));
});

test("a failed load says so, keeps Deny, and Retry loads it", async () => {
  const { app, card } = await openCard("large-approval", (fresh) =>
    fresh.daemon.failRequests("interaction.read"),
  );
  const alert = await within(card).findByRole("alert");
  expect(alert.textContent).toMatch(/Couldn't load the whole request/);
  expect(within(card).getByRole("button", { name: /Allow/ })).toHaveProperty("disabled", true);
  expect(within(card).getByRole("button", { name: /Deny/ })).toHaveProperty("disabled", false);
  app.daemon.restoreRequests();
  await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() =>
    expect(within(card).getByRole("button", { name: /Allow/ })).toHaveProperty("disabled", false),
  );
});

test("a summarized plan can be sent back, not approved, while it loads", async () => {
  const { card } = await openCard("large-plan", (app) =>
    app.daemon.holdRequests("interaction.read"),
  );
  expect(within(card).getByRole("button", { name: "Approve plan" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(within(card).getByRole("button", { name: "Request changes" })).toHaveProperty(
    "disabled",
    false,
  );
  expect(within(card).queryByText(/Move one parser into its own module\. \(2000\)/)).toBeNull();
});

test("a summarized plan shows in full once loaded and can then be approved", async () => {
  const { card, state } = await openCard("large-plan");
  await within(card).findByText(/Move one parser into its own module\. \(2000\)/);
  const approve = within(card).getByRole("button", { name: "Approve plan" });
  expect(approve).toHaveProperty("disabled", false);
  await userEvent.click(approve);
  await waitFor(() => expect(state()).toBe("resolved"));
});

test("a yes refused as not read reads the request again once, then goes", async () => {
  const { app, card, state } = await openCard("large-approval");
  // Each page the card reads passes the daemon's fault check: count them.
  let pages = 0;
  const fault = app.daemon.fault.bind(app.daemon);
  app.daemon.fault = (type) => {
    if (type === "interaction.read") pages++;
    return fault(type);
  };
  const allow = () => within(card).getByRole("button", { name: /Allow/ });
  await waitFor(() => expect(allow()).toHaveProperty("disabled", false));
  // The request changed since it was read, as the daemon says when it refuses.
  app.daemon.refuseCommands("request_not_read", "interaction.resolve");
  await userEvent.click(allow());
  expect(await within(card).findByText(/The request changed/)).toBeTruthy();
  app.daemon.restoreRequests();
  await waitFor(() => expect(pages).toBeGreaterThan(0));
  await waitFor(() => expect(allow()).toHaveProperty("disabled", false));
  const once = pages;
  // Read again once, not over and over.
  await new Promise((settle) => setTimeout(settle, 500));
  expect(pages).toBe(once);
  await userEvent.click(allow());
  await waitFor(() => expect(state()).toBe("resolved"));
});
