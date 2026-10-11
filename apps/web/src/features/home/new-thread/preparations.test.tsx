import { WorkspaceId } from "@ace/protocol";
import { fixtureImage, workbench } from "@ace/fake-daemon";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { writeDraft } from "@/features/thread/index.ts";
import { saveChoices } from "./choices.ts";
import { chooseModel, closeModelControl } from "@/test/model-control.ts";

function app(storage = memoryKeyValue()) {
  const made = harness({ storage });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  return made;
}
const message = () => screen.findByRole("combobox", { name: "Message" });
const drafts = () => screen.queryByRole("list", { name: "Draft threads" });
async function project(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: /^Project:/ }));
  await userEvent.click(await screen.findByRole("option", { name }));
  await message();
}

test("text and settings preparations in two projects reopen independently after reload", async () => {
  const storage = memoryKeyValue();
  const first = app(storage);
  await first.open("/new?project=relay");
  await userEvent.type(await message(), "Investigate relay reconnects");
  await chooseModel("GPT-5 Codex", "Codex");
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Model and effort" })).getByRole("button", {
      name: "High",
    }),
  );
  await closeModelControl();
  await project("billing-api");
  await userEvent.type(await message(), "Check billing retries");
  await chooseModel("GPT-5 Codex", "Codex");
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Model and effort" })).getByRole("button", {
      name: "Low",
    }),
  );
  await closeModelControl();
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "Draft threads" })).getAllByRole("link"),
    ).toHaveLength(2),
  );
  await userEvent.click(
    screen.getByRole("link", { name: "Investigate relay reconnects. Draft, Project relay" }),
  );
  expect((await message()).textContent).toBe("Investigate relay reconnects");
  expect(
    await screen.findByRole("button", { name: /Model: GPT-5 Codex, .*High effort/ }),
  ).toBeTruthy();
  cleanup();
  await first.client.close();
  await app(storage).open("/");
  await userEvent.click(
    await screen.findByRole("link", { name: "Investigate relay reconnects. Draft, Project relay" }),
  );
  expect((await message()).textContent).toBe("Investigate relay reconnects");
  expect(
    await screen.findByRole("button", { name: /Model: GPT-5 Codex, .*High effort/ }),
  ).toBeTruthy();
  await userEvent.click(
    screen.getByRole("link", { name: "Check billing retries. Draft, Project billing-api" }),
  );
  expect((await message()).textContent).toBe("Check billing retries");
  expect(
    await screen.findByRole("button", { name: /Model: GPT-5 Codex, .*Low effort/ }),
  ).toBeTruthy();
});

test("an untouched composer creates no row while a settings-only draft can be resumed and discarded", async () => {
  const storage = memoryKeyValue();
  const made = app(storage);
  await made.open("/new?project=relay");
  await message();
  const before = made.daemon.snapshot({ kind: "threads" });
  expect(drafts()).toBeNull();
  await userEvent.click(await screen.findByRole("button", { name: /^Approvals:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: "Plan" }));
  expect(
    await screen.findByRole("link", { name: "New preparation. Draft, Project relay" }),
  ).toBeTruthy();
  const prepared = made.daemon.snapshot({ kind: "threads" });
  expect(
    prepared?.kind === "threads" && before?.kind === "threads" ? Object.keys(prepared.threads) : [],
  ).toEqual(before?.kind === "threads" ? Object.keys(before.threads) : []);
  cleanup();
  await app(storage).open("/");
  await userEvent.click(
    await screen.findByRole("link", { name: "New preparation. Draft, Project relay" }),
  );
  expect(await screen.findByRole("button", { name: "Approvals: Plan" })).toBeTruthy();
  await userEvent.type(await message(), "Discard this text too");
  await userEvent.click(screen.getByRole("button", { name: "Discard draft in relay" }));
  await waitFor(() => expect(drafts()).toBeNull());
  expect((await message()).textContent).toBe("");
  cleanup();
  await app(storage).open("/new?project=relay");
  expect((await message()).textContent).toBe("");
  expect(drafts()).toBeNull();
});

test("an uploaded draft attachment survives navigation and first send promotes one row into one thread", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await message();
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("progressbar", { name: "Uploading notes.txt" })).toBeNull(),
  );
  await userEvent.type(await message(), "Read these notes");
  await project("billing-api");
  cleanup();
  await made.open("/");
  await userEvent.click(
    await screen.findByRole("link", { name: "Read these notes. Draft, Project relay" }),
  );
  expect(await screen.findByRole("button", { name: "Remove notes.txt" })).toBeTruthy();
  const before = made.daemon.snapshot({ kind: "threads" });
  await userEvent.type(await message(), "{Enter}");
  await screen.findByRole("heading", { level: 1, name: "Read these notes" });
  await waitFor(() => expect(drafts()).toBeNull());
  await waitFor(() => {
    const after = made.daemon.snapshot({ kind: "threads" });
    expect(
      after?.kind === "threads" && before?.kind === "threads"
        ? Object.keys(after.threads).length - Object.keys(before.threads).length
        : 0,
    ).toBe(1);
  });
});

test("a saved execution mode and base branch reopen with the preparation", async () => {
  const storage = memoryKeyValue();
  await app(storage).open("/new?project=relay");
  await message();
  await userEvent.click(await screen.findByRole("button", { name: /^Start from:/ }));
  await userEvent.type(await screen.findByRole("combobox", { name: "Start from branch" }), "dev");
  await userEvent.click(
    within(await screen.findByRole("group", { name: "Local" })).getByRole("option", {
      name: /^develop/,
    }),
  );
  await userEvent.click(screen.getByRole("checkbox", { name: "Worktree" }));
  cleanup();
  await app(storage).open("/");
  await userEvent.click(
    await screen.findByRole("link", { name: "New preparation. Draft, Project relay" }),
  );
  expect(screen.getByRole("checkbox", { name: "Worktree" }).getAttribute("aria-checked")).toBe(
    "false",
  );
  await userEvent.click(screen.getByRole("checkbox", { name: "Worktree" }));
  expect(await screen.findByRole("button", { name: "Start from: develop" })).toBeTruthy();
});

test("a visible preparation retains its content after fifty other composer drafts are saved", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await userEvent.type(await message(), "Protected preparation");
  await screen.findByRole("link", { name: "Protected preparation. Draft, Project relay" });
  await project("billing-api");
  for (let index = 0; index < 50; index++)
    writeDraft(made.storage, `thread:other-${index}`, {
      text: `Other ${index}`,
      mentions: [],
      attachments: [],
    });
  cleanup();
  await made.open("/");
  await userEvent.click(
    await screen.findByRole("link", { name: "Protected preparation. Draft, Project relay" }),
  );
  expect((await message()).textContent).toBe("Protected preparation");
});

test("discarding again after reload clears the active editor even when the route already has discard one", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await userEvent.type(await message(), "First discard");
  await userEvent.click(await screen.findByRole("button", { name: "Discard draft in relay" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(""),
  );
  await userEvent.type(await message(), "Second discard");
  await screen.findByRole("link", { name: "Second discard. Draft, Project relay" });
  cleanup();
  await made.open("/new?project=relay&discard=1");
  expect((await message()).textContent).toBe("Second discard");
  await userEvent.click(await screen.findByRole("button", { name: "Discard draft in relay" }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(""),
  );
  expect(drafts()).toBeNull();
  await userEvent.type(await message(), "Fresh content");
  cleanup();
  await made.open("/new?project=relay");
  expect((await message()).textContent).toBe("Fresh content");
});

test("typing before model discovery pins the settings shown when discovery finishes", async () => {
  const made = app();
  made.daemon.services.settings.seed({ "providers.default": "codex" });
  saveChoices(made.storage, { model: "last-provider-model", account: "last-provider-account" });
  made.daemon.holdRequests("models.list");
  await made.open("/new?project=relay");
  await userEvent.type(await message(), "Typed before discovery");
  await screen.findByRole("link", { name: "Typed before discovery. Draft, Project relay" });
  made.daemon.restoreRequests();
  const shown = await screen.findByRole("button", { name: /^Model: GPT-6\.1 Sol/ });
  const settingsShown = shown.getAttribute("aria-label");
  if (!settingsShown) throw new Error("model settings were not shown");
  await project("billing-api");
  cleanup();
  // Keep both models available but change the default chosen for a fresh composer.
  made.daemon.services.models = made.daemon.services.models.map((model) =>
    model.provider === "codex"
      ? { ...model, isDefault: model.displayName === "GPT-5 Codex", defaultEffort: "high" }
      : model,
  );
  await made.open("/");
  await userEvent.click(
    await screen.findByRole("link", { name: "Typed before discovery. Draft, Project relay" }),
  );
  expect((await message()).textContent).toBe("Typed before discovery");
  expect(await screen.findByRole("button", { name: settingsShown })).toBeTruthy();
});

test("a removed project's draft opens its saved content and recovery guidance instead of another project", async () => {
  const made = app();
  await made.open("/new?project=relay");
  await userEvent.type(await message(), "Unregistered project content");
  await project("billing-api");
  await userEvent.type(await message(), "Other project content");
  await made.client.enqueue({
    type: "workspace.remove",
    workspaceId: WorkspaceId.parse("relay"),
    archiveThreads: true,
  });
  await waitFor(async () => {
    const reply = await made.client.request({
      type: "workspace.request",
      operation: { op: "workspaces.list", limit: 100 },
    });
    expect(
      reply.result.kind === "workspaces" &&
        reply.result.workspaces.some((entry) => entry.id === "relay"),
    ).toBe(false);
  });
  cleanup();
  await made.open("/");
  await userEvent.click(
    await screen.findByRole("link", { name: "Unregistered project content. Draft, Project relay" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "This preparation's project is no longer registered",
  );
  expect(screen.getByLabelText("Saved message").textContent).toBe("Unregistered project content");
  expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
  expect(
    screen.getByRole("link", { name: "Other project content. Draft, Project billing-api" }),
  ).toBeTruthy();
});

test("a refused content write keeps the live preparation and shows that it is not saved", async () => {
  const backing = memoryKeyValue();
  const storage = {
    ...backing,
    get length() {
      return backing.data.size;
    },
    setItem(key: string, value: string) {
      if (key === "ace.composer.drafts") throw new Error("quota");
      backing.setItem(key, value);
    },
  };
  const made = app(storage);
  await made.open("/new?project=relay");
  await userEvent.type(await message(), "Keep this editor open");
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Couldn't save this preparation",
  );
  expect((await message()).textContent).toBe("Keep this editor open");
  expect(drafts()).toBeNull();
});

test("a recovered draft from the parent branch keeps its original uploaded file when migrated into a visible preparation", async () => {
  const made = app();
  await made.client.start();
  const host = (await made.client.request({ type: "host.identity" })).identity.hostId;
  const draft = await made.client.request({
    type: "context.request",
    operation: { op: "draft.create", workspaceId: WorkspaceId.parse("relay") },
  });
  if (draft.result.kind !== "draft") throw new Error("draft scope was not granted");
  const begun = await made.client.request({
    type: "context.request",
    operation: {
      op: "draft.upload.begin",
      draftId: draft.result.draftId,
      sha256: fixtureImage.sha256,
      bytes: atob(fixtureImage.data).length,
      mimeType: "image/png",
      name: fixtureImage.name,
    },
  });
  if (begun.result.kind !== "upload") throw new Error("upload was not granted");
  await made.client.request({
    type: "context.request",
    operation: {
      op: "upload.chunk",
      uploadId: begun.result.uploadId,
      offset: begun.result.offset,
      data: fixtureImage.data,
    },
  });
  const committed = await made.client.request({
    type: "context.request",
    operation: { op: "upload.commit", uploadId: begun.result.uploadId },
  });
  expect(committed.result.kind).toBe("attachment");
  writeDraft(made.storage, "new:relay", {
    text: "Recovered legacy upload",
    mentions: [],
    attachments: [{ sha256: fixtureImage.sha256, name: fixtureImage.name }],
  });
  made.storage.setItem(
    `ace.composer.scope:${JSON.stringify([host, "new:relay"])}`,
    JSON.stringify(draft.result.draftId),
  );
  await made.open("/new?project=relay");
  expect((await message()).textContent).toBe("Recovered legacy upload");
  expect(await screen.findByRole("button", { name: "Remove fixture.png" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => {
    const view = made.daemon.snapshot({ kind: "threads" });
    expect(
      view?.kind === "threads" &&
        Object.values(view.threads).some((thread) => thread.title === "Recovered legacy upload"),
    ).toBe(true);
  });
  const view = made.daemon.snapshot({ kind: "threads" });
  const created =
    view?.kind === "threads" &&
    Object.values(view.threads).find((thread) => thread.title === "Recovered legacy upload");
  if (!created) throw new Error("legacy preparation was not delivered");
  const reply = await made.client.request({
    type: "context.request",
    operation: { op: "attachment.list", threadId: created.id },
  });
  expect(
    reply.result.kind === "attachments" && reply.result.attachments.map((file) => file.sha256),
  ).toEqual([fixtureImage.sha256]);
});
