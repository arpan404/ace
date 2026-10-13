import { workbench } from "@ace/fake-daemon";
import { act, configure, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { memoryStorage } from "@/boot/client.ts";

configure({ asyncUtilTimeout: 30000 });

// Refused handoff writes (rows, content, rotation) are covered in handoff-refusal.test.tsx.
test("a second creation uploads its own files after the first thread starts", async () => {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  await made.open("/new?project=relay");
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "First creation");
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
        Object.values(view.threads).some((row) => row.title === "First creation"),
    ).toBe(true);
  });
  cleanup();
  await made.open("/new?project=relay");
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "Second creation");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["second"], "second.txt", { type: "text/plain" }),
  );
  await screen.findByRole("button", { name: "Remove second.txt" });
  await waitFor(() =>
    expect(screen.queryByRole("progressbar", { name: "Uploading second.txt" })).toBeNull(),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => {
    const view = made.daemon.snapshot({ kind: "threads" });
    expect(
      view?.kind === "threads" &&
        Object.values(view.threads).some((row) => row.title === "Second creation"),
    ).toBe(true);
  });
  const view = made.daemon.snapshot({ kind: "threads" });
  const created =
    view?.kind === "threads" &&
    Object.values(view.threads).find((row) => row.title === "Second creation");
  if (!created) throw new Error("second creation did not succeed");
  const reply = await made.client.request({
    type: "context.request",
    operation: { op: "attachment.list", threadId: created.id },
  });
  expect(
    reply.result.kind === "attachments" && reply.result.attachments.map((file) => file.name),
  ).toEqual(["second.txt"]);
});

test("a refusal after composer remount joins the current prompt and retains the submitted file", async () => {
  const gate = Promise.withResolvers<void>();
  const outbox = memoryStorage();
  let hold = false;
  const made = harness({
    outbox: {
      load: outbox.load,
      async save(value) {
        if (hold) {
          await gate.promise;
          throw new Error("storage full");
        }
        await outbox.save(value);
      },
    },
  });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  await made.open("/new?project=relay");
  await screen.findByRole("combobox", { name: "Message" });
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["original"], "original.txt", { type: "text/plain" }),
  );
  await screen.findByRole("button", { name: "Remove original.txt" });
  await waitFor(() =>
    expect(screen.queryByRole("progressbar", { name: "Uploading original.txt" })).toBeNull(),
  );
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "Original prompt");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  hold = true;
  await userEvent.keyboard("{Enter}");
  for (const project of ["billing-api", "relay"]) {
    await userEvent.click(await screen.findByRole("button", { name: /^Project:/ }));
    await userEvent.click(await screen.findByRole("option", { name: project }));
    await screen.findByRole("combobox", { name: "Message" });
  }
  await userEvent.clear(screen.getByRole("combobox", { name: "Message" }));
  await userEvent.type(screen.getByRole("combobox", { name: "Message" }), "Newer prompt");
  await act(async () => gate.resolve());
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
      "Newer prompt\n\nOriginal prompt",
    ),
  );
  expect(screen.getByRole("button", { name: "Remove original.txt" })).toBeTruthy();
  cleanup();
  await made.open("/new?project=relay");
  expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe(
    "Newer prompt\n\nOriginal prompt",
  );
  expect(screen.getByRole("button", { name: "Remove original.txt" })).toBeTruthy();
});

test("a new thread whose outbox cannot save restores its draft across reload", async () => {
  const storage = memoryKeyValue();
  const outbox = memoryStorage();
  let fail = false;
  const first = harness({
    storage,
    outbox: {
      load: outbox.load,
      save: async (value) => {
        if (fail) throw new Error("storage full");
        await outbox.save(value);
      },
    },
  });
  for (const scenario of workbench()) first.play(scenario).runUntilBlocked();
  await first.open("/new?project=relay");
  const field = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["saved notes"], "notes.txt", { type: "text/plain" }),
  );
  await screen.findByRole("button", { name: "Remove notes.txt" });
  await waitFor(() =>
    expect(screen.queryByRole("progressbar", { name: "Uploading notes.txt" })).toBeNull(),
  );
  await userEvent.type(field, "Restore the failed thread start");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  fail = true;
  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
      "Restore the failed thread start",
    ),
  );
  expect(await screen.findByRole("button", { name: "Remove notes.txt" })).toBeTruthy();
  cleanup();
  await first.client.close();
  const again = harness({ storage, outbox });
  for (const scenario of workbench()) again.play(scenario).runUntilBlocked();
  await again.open("/new?project=relay");
  expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe(
    "Restore the failed thread start",
  );
});

test("a rejected new-thread save preserves both prompts and the original file through reload and resubmission", async () => {
  const saving = Promise.withResolvers<void>();
  const storage = memoryKeyValue();
  const outbox = memoryStorage();
  let hold = false;
  const first = harness({
    storage,
    outbox: {
      load: outbox.load,
      save: async (value) => {
        if (hold) {
          await saving.promise;
          throw new Error("storage full");
        }
        await outbox.save(value);
      },
    },
  });
  for (const scenario of workbench()) first.play(scenario).runUntilBlocked();
  await first.open("/new?project=relay");
  const field = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["original notes"], "original.txt", { type: "text/plain" }),
  );
  await screen.findByRole("button", { name: "Remove original.txt" });
  await waitFor(() =>
    expect(screen.queryByRole("progressbar", { name: "Uploading original.txt" })).toBeNull(),
  );
  await userEvent.type(field, "Original prompt");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  hold = true;
  await userEvent.keyboard("{Enter}");
  await userEvent.type(screen.getByRole("combobox", { name: "Message" }), "Second draft");
  saving.resolve();
  await screen.findByText("This device couldn't save the new thread. Try again.");
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
      "Second draft\n\nOriginal prompt",
    ),
  );
  expect(screen.getByRole("button", { name: "Remove original.txt" })).toBeTruthy();
  cleanup();
  // Reload the page against the same daemon, which still owns the uploaded bytes.
  hold = false;
  await first.open("/new?project=relay");
  expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe(
    "Second draft\n\nOriginal prompt",
  );
  expect(await screen.findByRole("button", { name: "Remove original.txt" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => {
    const view = first.daemon.snapshot({ kind: "threads" });
    expect(
      view?.kind === "threads" &&
        Object.values(view.threads).some((thread) => thread.title.includes("Second draft")),
    ).toBe(true);
  });
  const view = first.daemon.snapshot({ kind: "threads" });
  const created =
    view?.kind === "threads" &&
    Object.values(view.threads).find((thread) => thread.title.includes("Second draft"));
  if (!created) throw new Error("thread was not created");
  const reply = await first.client.request({
    type: "context.request",
    operation: { op: "attachment.list", threadId: created.id },
  });
  expect(
    reply.result.kind === "attachments" && reply.result.attachments.map((file) => file.name),
  ).toEqual(["original.txt"]);
  const thread = first.daemon.snapshot({ kind: "thread", threadId: created.id });
  expect(
    thread?.kind === "thread" &&
      Object.values(thread.items).some(
        (item) =>
          item.type === "message" &&
          item.parts.some(
            (part) => part.type === "text" && part.text === "Second draft\n\nOriginal prompt",
          ) &&
          item.attachments?.some((file) => file.name === "original.txt"),
      ),
  ).toBe(true);
});

test("Edit on a refused new thread puts its message back in New thread for its project", async () => {
  const made = harness();
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  // In the checkout, so the refusal is the message's, not a worktree's.
  made.daemon.services.settings.seed({ "threads.useWorktree": false });
  made.daemon.refuseCommands("model_unavailable", "thread.create");
  await made.open("/new?project=relay");
  await screen.findByRole("button", { name: /^Model: Opus/ });
  await userEvent.type(
    await screen.findByRole("combobox", { name: "Message" }),
    "Bring my refused start back{Enter}",
  );
  await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  expect(await screen.findByRole("button", { name: "Project: relay" })).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
      "Bring my refused start back",
    ),
  );
});
