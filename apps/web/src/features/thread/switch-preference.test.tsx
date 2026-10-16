import { facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { chooseAccount, chooseModel, openModelControl } from "@/test/model-control.ts";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

async function openThread(fork: boolean) {
  const app = harness();
  app.daemon.services.settings.write("threads.forkOnSwitch", fork);
  const team = app.daemon.services.accounts.find((account) => account.id === "codex-team");
  if (!team) throw new Error("Missing Team account");
  app.daemon.services.updateQuota(team.id, { ...team.quota, windows: {} });
  app.daemon.createThread({
    id: "account-source",
    workspaceId: "ace",
    title: "Account switch",
    provider: "codex",
    execution: {
      provider: "codex",
      model: "gpt-5-codex",
      instanceId: "codex-personal",
      options: {},
    },
  });
  app.daemon.apply("account-source", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Remember amber"),
    facts.message("root", "answer", "assistant", "Amber is remembered"),
    facts.endTurn("root"),
  ]);
  await app.open("/t/account-source");
  await within(await screen.findByRole("feed", { name: "Transcript" })).findByText(
    "Amber is remembered",
  );
  return app;
}

test("forking an account switch leaves the source account and transcript intact", async () => {
  const app = await openThread(true);
  await chooseAccount(await openModelControl(/^Model: GPT-5 Codex, Personal/), "Team");
  const dialog = await screen.findByRole("dialog", { name: "Continue in a new thread?" });
  expect(within(dialog).getByText(/This thread stays as it is/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Codex" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Message" }));
  await userEvent.keyboard("Continue on Team{Enter}");
  await waitFor(() => {
    const list = app.daemon.snapshot({ kind: "threads" });
    const fork =
      list?.kind === "threads" &&
      Object.values(list.threads).find(
        (thread) => thread.lineage?.parentThreadId === "account-source",
      );
    expect(fork).toMatchObject({
      execution: { instanceId: "codex-team" },
      lineage: { parentThreadId: "account-source" },
    });
  });
  const source = app.daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse("account-source"),
  });
  if (source?.kind !== "thread") throw new Error("Missing source");
  expect(source.thread.execution?.instanceId).toBe("codex-personal");
  expect(source.thread.switch).toBeUndefined();
  const messages = Object.values(source.items).flatMap((item) =>
    item.type === "message"
      ? item.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
  expect(messages).toContain("Amber is remembered");
  expect(messages).not.toContain("Continue on Team");
});

test("switching with forking disabled keeps using the existing thread", async () => {
  const app = await openThread(false);
  await chooseAccount(await openModelControl(/^Model: GPT-5 Codex, Personal/), "Team");
  await waitFor(() => {
    const list = app.daemon.snapshot({ kind: "threads" });
    if (list?.kind !== "threads") throw new Error("Missing threads");
    expect(list.threads["account-source"]?.execution?.instanceId).toBe("codex-team");
    expect(
      Object.values(list.threads).filter(
        (thread) => thread.lineage?.parentThreadId === "account-source",
      ),
    ).toEqual([]);
  });
  expect(screen.queryByRole("dialog", { name: "Continue in a new thread?" })).toBeNull();
});

async function openProviderThread(fork: boolean) {
  const app = harness();
  app.daemon.services.settings.write("threads.forkOnSwitch", fork);
  app.daemon.createThread({
    id: "provider-source",
    workspaceId: "ace",
    title: "Provider switch",
    provider: "claude",
    execution: { provider: "claude", model: "claude-opus-5-5", instanceId: "claude", options: {} },
  });
  app.daemon.apply("provider-source", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Remember amber"),
    facts.message("root", "answer", "assistant", "Amber is remembered"),
    facts.endTurn("root"),
  ]);
  await app.open("/t/provider-source");
  await within(await screen.findByRole("feed", { name: "Transcript" })).findByText(
    "Amber is remembered",
  );
  return app;
}

test("forking a provider switch keeps the original provider and sends only in the new thread", async () => {
  const app = await openProviderThread(true);
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Opus 5.5/);
  const dialog = await screen.findByRole("dialog", { name: "Continue in a new thread?" });
  expect(within(dialog).getByText(/This thread stays as it is/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Codex" }));
  await userEvent.click(screen.getByRole("combobox", { name: "Message" }));
  await userEvent.keyboard("Continue on Codex{Enter}");
  await waitFor(() => {
    const list = app.daemon.snapshot({ kind: "threads" });
    if (list?.kind !== "threads") throw new Error("Missing threads");
    expect(
      Object.values(list.threads).filter(
        (thread) => thread.lineage?.parentThreadId === "provider-source",
      ),
    ).toMatchObject([{ provider: "codex", lineage: { mode: "portable" } }]);
  });
  const source = app.daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse("provider-source"),
  });
  if (source?.kind !== "thread") throw new Error("Missing source");
  expect(source.thread.provider).toBe("claude");
  expect(source.thread.switch).toBeUndefined();
  const said = Object.values(source.items).flatMap((item) =>
    item.type === "message"
      ? item.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : [],
  );
  expect(said).toContain("Amber is remembered");
  expect(said).not.toContain("Continue on Codex");
});

test("a provider switch with preservation disabled continues in the current thread", async () => {
  const app = await openProviderThread(false);
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Opus 5.5/);
  const dialog = await screen.findByRole("dialog", { name: "Switch to Codex?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Switch to Codex" }));
  await waitFor(() => {
    const list = app.daemon.snapshot({ kind: "threads" });
    if (list?.kind !== "threads") throw new Error("Missing threads");
    expect(list.threads["provider-source"]?.provider).toBe("codex");
    expect(
      Object.values(list.threads).filter(
        (thread) => thread.lineage?.parentThreadId === "provider-source",
      ),
    ).toEqual([]);
  });
});

test("an open preservation confirmation does not change its action when the setting changes", async () => {
  const app = await openProviderThread(true);
  await chooseModel("GPT-5 Codex", "Codex", /^Model: Opus 5.5/);
  const dialog = await screen.findByRole("dialog", { name: "Continue in a new thread?" });
  app.daemon.services.settings.write("threads.forkOnSwitch", false);
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Codex" }));
  const source = app.daemon.snapshot({
    kind: "thread",
    threadId: ThreadId.parse("provider-source"),
  });
  expect(source?.kind === "thread" && source.thread.provider).toBe("claude");
  expect(await screen.findByRole("button", { name: /^Model: GPT-5 Codex/ })).toBeTruthy();
});

test("model-only changes stay in the same thread when preservation is enabled", async () => {
  const app = await openThread(true);
  await chooseModel("GPT-6.1 Sol", "Codex", /^Model: GPT-5 Codex, Personal/);
  await waitFor(() => {
    const list = app.daemon.snapshot({ kind: "threads" });
    if (list?.kind !== "threads") throw new Error("Missing threads");
    expect(list.threads["account-source"]?.execution?.model).toBe("gpt-6.1-sol");
    expect(
      Object.values(list.threads).filter(
        (thread) => thread.lineage?.parentThreadId === "account-source",
      ),
    ).toEqual([]);
  });
  expect(screen.queryByRole("dialog", { name: "Continue in a new thread?" })).toBeNull();
});
