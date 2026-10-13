import { workbench } from "@ace/fake-daemon";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { memoryStorage } from "@/boot/client.ts";

function delayedSave() {
  const gate = Promise.withResolvers<void>();
  const outbox = memoryStorage();
  let hold = false;
  let reject = false;
  const made = harness({
    outbox: {
      load: outbox.load,
      async save(value) {
        if (hold) {
          await gate.promise;
          if (reject) throw new Error("storage full");
        }
        await outbox.save(value);
      },
    },
  });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  return {
    made,
    gate,
    hold: () => {
      hold = true;
    },
    reject: () => {
      reject = true;
      gate.resolve();
    },
  };
}
const message = () => screen.findByRole("combobox", { name: "Message" });
async function readyToSend() {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
}
async function project(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: /^Project:/ }));
  await userEvent.click(await screen.findByRole("option", { name }));
  await message();
}

async function delivered(made: ReturnType<typeof harness>, title: string) {
  await waitFor(() => {
    const view = made.daemon.snapshot({ kind: "threads" });
    expect(
      view?.kind === "threads" &&
        Object.values(view.threads).some((thread) => thread.title === title),
    ).toBe(true);
  });
}

test("an earlier page's successful save cannot erase or navigate away from a reopened preparation", async () => {
  const { made, gate, hold } = delayedSave();
  await made.open("/new?project=relay");
  await userEvent.type(await message(), "Original preparation");
  await readyToSend();
  hold();
  await userEvent.keyboard("{Enter}");
  await project("billing-api");
  await userEvent.click(
    await screen.findByRole("link", { name: "Original preparation. Draft, Project relay" }),
  );
  const reopened = await message();
  await userEvent.clear(reopened);
  await userEvent.type(reopened, "Newer preparation");
  await act(async () => gate.resolve());
  await delivered(made, "Original preparation");
  expect((await message()).textContent).toBe("Newer preparation");
  expect(
    screen.getByRole("link", { name: "Newer preparation. Draft, Project relay" }),
  ).toBeTruthy();
  cleanup();
  await made.open("/new?project=relay");
  expect((await message()).textContent).toBe("Newer preparation");
});

test("typing a second preparation during the first save gives its later files a fresh daemon scope", async () => {
  const { made, gate, hold } = delayedSave();
  await made.open("/new?project=relay");
  await userEvent.type(await message(), "First preparation");
  await readyToSend();
  hold();
  await userEvent.keyboard("{Enter}");
  await userEvent.type(await message(), "Second preparation");
  await act(async () => gate.resolve());
  await delivered(made, "First preparation");
  await userEvent.click(
    await screen.findByRole("link", { name: "Second preparation. Draft, Project relay" }),
  );
  await readyToSend();
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["second file"], "second.txt", { type: "text/plain" }),
  );
  await screen.findByRole("button", { name: "Remove second.txt" });
  await waitFor(() =>
    expect(screen.queryByRole("progressbar", { name: "Uploading second.txt" })).toBeNull(),
  );
  await readyToSend();
  await userEvent.click(screen.getByRole("button", { name: "Send" }));
  await delivered(made, "Second preparation");
  const view = made.daemon.snapshot({ kind: "threads" });
  const created =
    view?.kind === "threads" &&
    Object.values(view.threads).find((thread) => thread.title === "Second preparation");
  if (!created) throw new Error("second preparation was not delivered");
  const reply = await made.client.request({
    type: "context.request",
    operation: { op: "attachment.list", threadId: created.id },
  });
  expect(
    reply.result.kind === "attachments" && reply.result.attachments.map((file) => file.name),
  ).toEqual(["second.txt"]);
});

test("a refused save from an earlier page returns its prompt and file beside the reopened editor's new work", async () => {
  const { made, hold, reject } = delayedSave();
  await made.open("/new?project=relay");
  await message();
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["original"], "original.txt", { type: "text/plain" }),
  );
  await screen.findByRole("button", { name: "Remove original.txt" });
  await waitFor(() =>
    expect(screen.queryByRole("progressbar", { name: "Uploading original.txt" })).toBeNull(),
  );
  await userEvent.type(await message(), "Original preparation");
  await readyToSend();
  hold();
  await userEvent.keyboard("{Enter}");
  await project("billing-api");
  await userEvent.click(
    await screen.findByRole("link", { name: "Original preparation. Draft, Project relay" }),
  );
  await userEvent.clear(await message());
  await userEvent.type(await message(), "Newer work");
  await act(async () => reject());
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
      "Newer work\n\nOriginal preparation",
    ),
  );
  expect(screen.getByRole("button", { name: "Remove original.txt" })).toBeTruthy();
  cleanup();
  await made.open("/new?project=relay");
  expect((await message()).textContent).toBe("Newer work\n\nOriginal preparation");
  expect(screen.getByRole("button", { name: "Remove original.txt" })).toBeTruthy();
});

test("a successful save still promotes an unchanged preparation after its page closes", async () => {
  const { made, gate, hold } = delayedSave();
  await made.open("/new?project=relay");
  await userEvent.type(await message(), "Promote the original");
  await readyToSend();
  hold();
  await userEvent.keyboard("{Enter}");
  await project("billing-api");
  await act(async () => gate.resolve());
  await delivered(made, "Promote the original");
  expect(
    screen.queryByRole("link", { name: "Promote the original. Draft, Project relay" }),
  ).toBeNull();
  cleanup();
  await made.open("/new?project=relay");
  expect((await message()).textContent).toBe("");
});
