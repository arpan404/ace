import { workbench } from "@ace/fake-daemon";
import { configure, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { memoryStorage } from "@/boot/client.ts";

configure({ asyncUtilTimeout: 30000 });

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

test("a rejected new-thread save returns the first prompt beside a newer draft and keeps both after reload", async () => {
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
  await userEvent.type(field, "ORIGINAL_PROMPT");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("aria-disabled")).not.toBe(
      "true",
    ),
  );
  hold = true;
  await userEvent.keyboard("{Enter}");
  await userEvent.type(screen.getByRole("combobox", { name: "Message" }), "SECOND_DRAFT");
  saving.resolve();
  await screen.findByText("This device couldn't save the new thread. Try again.");
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe(
      "SECOND_DRAFT\n\nORIGINAL_PROMPT",
    ),
  );
  cleanup();
  await first.client.close();
  const again = harness({ storage, outbox });
  for (const scenario of workbench()) again.play(scenario).runUntilBlocked();
  await again.open("/new?project=relay");
  expect((await screen.findByRole("combobox", { name: "Message" })).textContent).toBe(
    "SECOND_DRAFT\n\nORIGINAL_PROMPT",
  );
});
