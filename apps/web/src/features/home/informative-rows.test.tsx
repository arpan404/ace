import { facts } from "@ace/fake-daemon";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

function task(app: ReturnType<typeof harness>, id: string, title: string) {
  app.daemon.createThread({
    id,
    title,
    workspaceId: "ace",
    provider: "codex",
    details: {
      branch: "fix/replay",
      linkedPr: { number: 283, state: "open", draft: true },
      diff: { files: 2, additions: 24, deletions: 6 },
    },
  });
  app.daemon.apply(id, [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Fix replay"),
  ]);
}
const rows = async () => within(await screen.findByRole("list", { name: "Threads" }));

test("PR state, changes, status words and provider stay visible together", async () => {
  const app = harness();
  task(app, "build", "Build replay recovery");
  await app.open("/new");
  const row = await (await rows()).findByRole("link", { name: /^Build replay recovery/ });
  expect(within(row).getByText("Working", { exact: true })).toBeTruthy();
  expect(within(row).getByRole("img", { name: "draft pull request #283" })).toBeTruthy();
  expect(within(row).getByText("+24")).toBeTruthy();
  expect(within(row).getByText("−6")).toBeTruthy();
  expect(within(row).getByRole("img", { name: "Codex" })).toBeTruthy();
  await userEvent.hover(row);
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toContain("Build replay recovery");
  expect(tip.textContent).toContain("Working");
  expect(tip.textContent).toContain("draft pull request");
});

test("this device's read cursor shows new activity even while a task works", async () => {
  const app = harness();
  task(app, "build", "Build replay recovery");
  app.daemon.markReadThrough("build", "ask", "test-device");
  app.daemon.apply("build", [
    facts.subagent("codex", "web", "Web", "spawn"),
    facts.turn("web", "spawn"),
  ]);
  await app.open("/new");
  const row = await (await rows()).findByRole("link", { name: /^Build replay recovery/ });
  expect(await within(row).findByRole("img", { name: "Unread activity" })).toBeTruthy();
  expect(within(row).getByText("⑂ 1")).toBeTruthy();
});

test("agents running beside a human request remain counted until they finish", async () => {
  const app = harness();
  task(app, "build", "Build replay recovery");
  app.daemon.apply("build", [
    facts.subagent("codex", "web", "Web", "spawn"),
    facts.turn("web", "spawn"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "approve",
      blocking: true,
      request: { kind: "approval", title: "Publish", options: [] },
    },
  ]);
  await app.open("/new");
  const row = await (await rows()).findByRole("link", { name: /^Build replay recovery/ });
  expect(within(row).getByText("Needs you")).toBeTruthy();
  expect(within(row).getByText("⑂ 1")).toBeTruthy();
  app.daemon.apply("build", [facts.endTurn("web")]);
  await waitFor(() => expect(within(row).queryByText("⑂ 1")).toBeNull());
  expect(within(row).getByText("Needs you")).toBeTruthy();
});

test("renaming an empty draft cannot turn it into a task", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "draft",
    title: "New thread",
    workspaceId: "ace",
    provider: "opencode",
  });
  app.daemon.updateThread("draft", { title: "Renamed draft" });
  await app.open("/new");
  await screen.findByText("No threads yet");
  expect(screen.queryByRole("link", { name: /^Renamed draft/ })).toBeNull();
  app.daemon.apply("draft", [
    facts.rootAgent("opencode"),
    facts.turn("root"),
    facts.message("root", "sent", "user", "Fix replay"),
  ]);
  expect(await screen.findByRole("link", { name: /^Renamed draft/ })).toBeTruthy();
});
