import { workbench } from "@ace/fake-daemon";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { memoryStorage } from "@/boot/client.ts";
import { readCreateAttempt } from "./create-attempt.ts";

async function ready() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
}
async function delivered(made: ReturnType<typeof harness>, title: string) {
  await waitFor(() => {
    const view = made.daemon.snapshot({ kind: "threads" });
    expect(
      view?.kind === "threads" &&
        Object.values(view.threads).some((thread) => thread.title === title),
    ).toBe(true);
  });
  const view = made.daemon.snapshot({ kind: "threads" });
  const created =
    view?.kind === "threads" &&
    Object.values(view.threads).find((thread) => thread.title === title);
  if (!created) throw new Error("thread was not delivered");
  return created;
}

test.each(["content", "rows", "row deletion", "rotation"])(
  "an accepted create stays recoverable when handoff %s is refused, and later files use a fresh scope",
  async (refusal) => {
    const backing = memoryKeyValue();
    let full = false;
    const storage = {
      ...backing,
      setItem(key: string, value: string) {
        if (
          full &&
          ((refusal === "content" && key === "ace.composer.drafts") ||
            (key.startsWith("ace.preparations:") &&
              (refusal === "rows" || refusal === "rotation" || value === "[]")))
        )
          throw new Error("quota");
        backing.setItem(key, value);
      },
    };
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const outbox = memoryStorage();
    let hold = false;
    const made = harness({
      storage,
      outbox: {
        load: outbox.load,
        async save(value) {
          if (hold) {
            entered.resolve();
            await gate.promise;
            full = true;
          }
          await outbox.save(value);
        },
      },
    });
    for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
    await made.open("/new?project=relay");
    await userEvent.type(
      await screen.findByRole("combobox", { name: "Message" }),
      "First accepted preparation",
    );
    await ready();
    await userEvent.upload(
      screen.getByLabelText("Files to attach"),
      new File(["original"], "original.txt", { type: "text/plain" }),
    );
    await screen.findByRole("button", { name: "Remove original.txt" });
    await waitFor(() =>
      expect(screen.queryByRole("progressbar", { name: "Uploading original.txt" })).toBeNull(),
    );
    await screen.findByRole("button", { name: "Start from: origin/main" });
    await ready();
    hold = true;
    await userEvent.keyboard("{Enter}");
    await entered.promise;
    const recoveryKey = [...backing.data.keys()].find((key) => key.startsWith("ace.createAttempt:"));
    if (!recoveryKey) throw new Error("create recovery was not reserved");
    if (refusal === "rotation")
      await userEvent.type(screen.getByRole("combobox", { name: "Message" }), "Second preparation");
    await act(async () => gate.resolve());
    const first = await delivered(made, "First accepted preparation");
    const original = await made.client.request({
      type: "context.request",
      operation: { op: "attachment.list", threadId: first.id },
    });
    expect(
      original.result.kind === "attachments" &&
        original.result.attachments.map((file) => file.name),
    ).toEqual(["original.txt"]);
    await waitFor(() => expect(readCreateAttempt(storage, recoveryKey)).toBeUndefined());
    cleanup();
    await made.client.close();
    // A new client and storage wrapper discard the page's retirement cache. The daemon must
    // reject the durable adopted ID, while retaining the already delivered thread's file.
    const again = harness({ daemon: made.daemon, storage: { ...storage }, outbox });
    await again.open("/new?project=relay");
    if (refusal === "rotation") {
      expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe(
        "Second preparation",
      );
      await screen.findByText(/Couldn't save this preparation/);
      full = false;
    } else {
      await userEvent.click(await screen.findByRole("button", { name: "Discard draft in relay" }));
      await screen.findByText(/Couldn't discard the draft on this device/);
      full = false;
      await userEvent.click(screen.getByRole("button", { name: "Discard draft in relay" }));
      await waitFor(() =>
        expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(""),
      );
      await userEvent.type(screen.getByRole("combobox", { name: "Message" }), "Second preparation");
    }
    hold = false;
    await ready();
    await userEvent.upload(
      screen.getByLabelText("Files to attach"),
      new File(["second"], "second.txt", { type: "text/plain" }),
    );
    await screen.findByRole("button", { name: "Remove second.txt" });
    await waitFor(() =>
      expect(screen.queryByRole("progressbar", { name: "Uploading second.txt" })).toBeNull(),
    );
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    const second = await delivered(again, "Second preparation");
    const uploaded = await again.client.request({
      type: "context.request",
      operation: { op: "attachment.list", threadId: second.id },
    });
    expect(
      uploaded.result.kind === "attachments" &&
        uploaded.result.attachments.map((file) => file.name),
    ).toEqual(["second.txt"]);
  },
);
