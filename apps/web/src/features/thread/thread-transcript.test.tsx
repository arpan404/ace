import { coldStartReplay, replayCursor } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function openReplay(through = "finding") {
  const app = harness();
  const script = app.play(replayCursor());
  script.runThrough(through);
  await app.open("/t/thread-replay-cursor");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  return { app, script, feed };
}

test("tool work collapses into one line that opens to its steps and their output", async () => {
  const { feed } = await openReplay("answered");
  const summary = await within(feed).findByRole("button", { name: /^Worked for/ });
  expect(summary.textContent).toContain(
    "Explored 3 files · 1 search · Ran 2 commands · Edited 2 files",
  );
  expect(within(feed).queryByText("apps/server/src/cursor.ts")).toBeNull();

  await userEvent.click(summary);
  const steps = within(feed).getByRole("list", { name: "Steps" });
  expect(within(steps).getByText("apps/server/src/cursor.ts")).toBeTruthy();
  expect(within(steps).getByText("4 matches")).toBeTruthy();

  await userEvent.click(
    within(steps).getByRole("button", { name: /Ran bun run test apps\/server/ }),
  );
  expect(within(steps).getByLabelText("Output").textContent).toContain("Tests  16 passed (16)");
  expect(within(steps).getByText("Exit code 0")).toBeTruthy();

  await userEvent.click(
    within(steps).getByRole("button", { name: /Edited apps\/web\/src\/relay\/outbox.ts/ }),
  );
  const diff = within(steps).getByLabelText("Diff of apps/web/src/relay/outbox.ts");
  expect(diff.textContent).toContain('const ack = await socket.waitFor("resume.ack");');
});

test("the answer reads as prose with a code block that copies", async () => {
  const user = userEvent.setup();
  const { feed } = await openReplay("answered");
  const bold = await within(feed).findByText("Server:");
  expect(bold.tagName).toBe("STRONG");
  expect(within(feed).getAllByText("lastAckedSeq")[0]?.tagName).toBe("CODE");

  await user.click(within(feed).getByRole("button", { name: "Copy code" }));
  expect(await navigator.clipboard.readText()).toContain(
    "expect(new Set(client.ids()).size).toBe(client.ids().length);",
  );
  expect(within(feed).getByRole("button", { name: "Copied" })).toBeTruthy();
});

test("the changed-files card lists the turn's files and opens the Changes tab", async () => {
  const { feed } = await openReplay("answered");
  const card = await within(feed).findByRole("region", { name: "2 changed files" });
  expect(within(card).queryByText("apps/server/src/replay.ts")).toBeNull();

  await userEvent.click(within(card).getByRole("button", { name: "Show files" }));
  expect(within(card).getByText("apps/server/src/replay.ts")).toBeTruthy();
  expect(within(card).getByText("apps/web/src/relay/outbox.ts")).toBeTruthy();

  await userEvent.click(within(card).getByRole("button", { name: "Open diff" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(
    within(panel)
      .getByRole("tab", { name: /^Changes/ })
      .getAttribute("aria-selected"),
  ).toBe("true");
});

test("a full-text edit's changed-files stat counts the lines that changed, as Changes does", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-1");
  await app.open("/t/thread-cold-start");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const card = await within(feed).findByRole("region", { name: "1 changed file" });
  const stat = await waitFor(() => {
    const text = card.textContent?.match(/\+(\d+) −(\d+)/);
    expect(text).toBeTruthy();
    return text;
  });
  // replay.ts is far longer than the edit, so a whole-file count would be much larger.
  expect(Number(stat?.[1])).toBeGreaterThan(0);
  expect(Number(stat?.[1])).toBeLessThan(20);

  // The work log's step for the same edit reads the same count.
  await userEvent.click(await within(feed).findByRole("button", { name: /^Worked for/ }));
  const step = within(feed).getByRole("button", { name: /^Edited apps\/server\/src\/replay.ts/ });
  await waitFor(() => expect(step.textContent).toContain(`+${stat?.[1]} −${stat?.[2]}`));

  await userEvent.click(within(card).getByRole("button", { name: "Open diff" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  const tab = within(panel).getByRole("tab", { name: /^Changes/ });
  await waitFor(() => expect(tab.textContent).toContain(`+${stat?.[1]} −${stat?.[2]}`));
});

test("subagents open inline as a tree, and the agent tree is one click away", async () => {
  const { feed } = await openReplay("delegated");
  await userEvent.click(await within(feed).findByRole("button", { name: "Started 2 subagents" }));
  const tree = within(feed).getByRole("tree", { name: "Subagents" });
  expect(
    within(tree).getByRole("treeitem", { name: "Claude Code: Waiting for subagents" }),
  ).toBeTruthy();
  expect(
    within(tree).getByRole("treeitem", {
      name: "reconnect-audit: Reading apps/mobile/src/resume.ts",
    }),
  ).toBeTruthy();
  expect(
    within(tree).getByRole("treeitem", { name: "regression-test: bun run test replay" }),
  ).toBeTruthy();

  await userEvent.click(within(feed).getByRole("button", { name: /Open agent tree/ }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { selected: true }).textContent).toBe("Agents");
});

test("the live line says which subagents the agent is waiting on", async () => {
  await openReplay("finding");
  expect(
    await screen.findByRole("status", { name: "Waiting on reconnect-audit and regression-test" }),
  ).toBeTruthy();
});

test("a network retry holds still: no spinner, no shimmer", async () => {
  const { app } = await openReplay("finding");
  app.daemon.apply("thread-replay-cursor", [
    { type: "retry", agent: "root", on: "network", message: "connection reset" },
  ]);
  const line = await screen.findByRole("status", { name: "Network trouble" });
  expect(line.querySelector('[data-slot="spinner"]')).toBeNull();
  expect(line.querySelector(".shimmer")).toBeNull();
});

test("stopping a background task waits for the daemon to report it stopped", async () => {
  const { feed } = await openReplay("background");
  const line = await within(feed).findByRole("group", {
    name: "Background task bun run dev:relay",
  });
  expect(within(line).getByText("Running in background")).toBeTruthy();

  await userEvent.click(within(line).getByRole("button", { name: "Stop" }));
  await within(line).findByText("Stopped");
  expect(within(line).queryByRole("button", { name: "Stop" })).toBeNull();
});

test("returning to a thread marks where the new activity starts", async () => {
  const { script, feed } = await openReplay("background");
  await within(feed).findByText("Running in background");
  expect(screen.queryByRole("separator", { name: "New activity" })).toBeNull();

  // The sidebar's bell: Activity's way in.
  await userEvent.click(
    within(screen.getByRole("navigation", { name: "App" })).getByRole("link", {
      name: /^Activity/,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("feed", { name: "Transcript" })).toBeNull());
  await act(async () => script.runThrough("finding"));

  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  const again = await screen.findByRole("feed", { name: "Transcript" });
  const divider = await within(again).findByRole("separator", { name: "New activity" });
  const article = divider.closest("[role=article]");
  expect(article?.textContent).toContain("reconnect-audit found one more path");
});
