import { workbench } from "@ace/fake-daemon";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { readDraft } from "@/features/thread/index.ts";
import { preparationKey } from "./preparations.ts";

test.each(["content", "row", "final row and rollback"])(
  "a refused discard of %s retains a recoverable prompt and attachment scope",
  async (refusal) => {
    const backing = memoryKeyValue();
    let fail = false;
    let removingRowFailed = false;
    const storage = {
      ...backing,
      setItem(key: string, value: string) {
        if (
          fail &&
          key === "ace.composer.drafts" &&
          (refusal === "content" || (removingRowFailed && value !== "[]"))
        )
          throw new Error("content quota");
        if (
          fail &&
          key.startsWith("ace.preparations:") &&
          (refusal === "row" || (refusal === "final row and rollback" && value === "[]"))
        ) {
          removingRowFailed = true;
          throw new Error("row quota");
        }
        backing.setItem(key, value);
      },
    };
    const made = harness({ storage });
    for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
    await made.open("/new?project=relay");
    const field = await screen.findByRole("combobox", { name: "Message" });
    await userEvent.upload(
      screen.getByLabelText("Files to attach"),
      new File(["retained file"], "retained.txt", { type: "text/plain" }),
    );
    await screen.findByRole("button", { name: "Remove retained.txt" });
    await waitFor(() =>
      expect(screen.queryByRole("progressbar", { name: "Uploading retained.txt" })).toBeNull(),
    );
    await userEvent.type(field, "Retain refused discard");
    await screen.findByRole("link", { name: "Retain refused discard. Draft, Project relay" });
    const host = (await made.client.request({ type: "host.identity" })).identity.hostId;
    await waitFor(() =>
      expect(readDraft(storage, preparationKey(host, "relay"))?.text).toBe(
        "Retain refused discard",
      ),
    );
    fail = true;
    await userEvent.click(screen.getByRole("button", { name: "Discard draft in relay" }));
    expect(
      await screen.findByText(
        "Couldn't discard the draft on this device. Your saved work and files are kept. Free space and try again.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Retain refused discard. Draft, Project relay" }),
    ).toBeTruthy();
    if (refusal === "final row and rollback") {
      expect((await screen.findByLabelText("Saved message")).textContent).toBe(
        "Retain refused discard",
      );
      expect(screen.getByRole("list", { name: "Saved attachments" }).textContent).toBe("retained.txt");
    } else {
      expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
        "Retain refused discard",
      );
      expect(screen.getByRole("button", { name: "Remove retained.txt" })).toBeTruthy();
    }
    // Reload after storage becomes writable. The same daemon must still own the original file.
    cleanup();
    fail = false;
    await made.open("/new?project=relay");
    expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe(
      "Retain refused discard",
    );
    expect(screen.getByRole("button", { name: "Remove retained.txt" })).toBeTruthy();
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
          Object.values(view.threads).some((thread) => thread.title === "Retain refused discard"),
      ).toBe(true);
    });
    const view = made.daemon.snapshot({ kind: "threads" });
    const created =
      view?.kind === "threads" &&
      Object.values(view.threads).find((thread) => thread.title === "Retain refused discard");
    if (!created) throw new Error("retained draft was not submitted");
    const reply = await made.client.request({
      type: "context.request",
      operation: { op: "attachment.list", threadId: created.id },
    });
    expect(
      reply.result.kind === "attachments" && reply.result.attachments.map((file) => file.name),
    ).toEqual(["retained.txt"]);
  },
);
