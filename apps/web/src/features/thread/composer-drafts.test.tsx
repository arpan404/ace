import { longHistory, replayCursor } from "@ace/fake-daemon";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

function app(storage = memoryKeyValue()) {
  const made = harness({ storage });
  made.play(longHistory(2)).runUntilBlocked();
  made.play(replayCursor()).runThrough("finding");
  return made;
}
const message = () =>
  screen.findByRole("combobox", { name: "Message" }) as Promise<HTMLTextAreaElement>;
const threads = () => screen.getByRole("navigation", { name: "Threads" });

test("an unsent draft is still there after visiting another thread", async () => {
  await app().open("/t/thread-router");
  await userEvent.type(await message(), "Half a thought about nested routes");

  await userEvent.click(within(threads()).getByRole("link", { name: /Replay cursor resets/ }));
  await screen.findByRole("heading", { level: 1, name: "Replay cursor resets on every resume" });
  // The other thread has its own, empty draft.
  expect((await message()).value).toBe("");

  await userEvent.click(within(threads()).getByRole("link", { name: /Document the router/ }));
  await screen.findByRole("heading", { level: 1, name: "Document the router" });
  expect((await message()).value).toBe("Half a thought about nested routes");
});

test("a draft and its uploaded files survive a reload, and go once the message is sent", async () => {
  const storage = memoryKeyValue();
  const running = app(storage);
  await running.open("/t/thread-router");
  await userEvent.type(await message(), "Compare with @");
  await userEvent.keyboard("{Escape}");
  await userEvent.upload(
    screen.getByLabelText("Files to attach"),
    new File(["route table"], "routes.txt", { type: "text/plain" }),
  );
  const chips = screen.getByRole("list", { name: "Attachments" });
  await waitFor(() => expect(within(chips).queryByRole("progressbar")).toBeNull());
  cleanup();

  // A browser reload retains the daemon, including its scoped upload bytes.
  const reloaded = running;
  await reloaded.open("/t/thread-router");
  const field = await message();
  expect(field.value).toBe("Compare with @");
  expect(
    within(screen.getByRole("list", { name: "Attachments" })).getByText("routes.txt"),
  ).toBeTruthy();

  await userEvent.clear(field);
  await userEvent.type(field, "Compare with the table{Enter}");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  expect(await within(feed).findByText("Compare with the table")).toBeTruthy();
  cleanup();

  await running.open("/t/thread-router");
  expect((await message()).value).toBe("");
  expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
});
