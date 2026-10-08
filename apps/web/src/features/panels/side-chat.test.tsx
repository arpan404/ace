import { coldStartReplay } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("Side chat says it isn't available yet, offers a fork instead, and keeps the composer's shape switched off", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Alt>}{Meta>}s{/Meta}{/Alt}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { name: "Side chat", selected: true })).toBeTruthy();

  const box = await within(panel).findByRole("combobox", { name: "Side chat message" });
  expect(box.getAttribute("aria-disabled")).toBe("true");
  const reason = document.getElementById(box.getAttribute("aria-describedby") ?? "");
  expect(reason?.textContent).toBe(
    "Side chats aren't available yet. To explore without changing this thread, fork it.",
  );
  expect(box.getAttribute("aria-placeholder")).toBe("Side chats aren't available yet");
  // The same send button as the thread's composer, saying why it can't send.
  const send = within(panel).getByRole("button", { name: "Send" });
  expect(send.getAttribute("aria-disabled")).toBe("true");
  // + looks and reads unavailable too, with the same reason, and opens nothing.
  const add = within(panel).getByRole("button", { name: "Add files and context" });
  expect(add.getAttribute("aria-disabled")).toBe("true");
  expect(document.getElementById(add.getAttribute("aria-describedby") ?? "")).toBe(reason);
  await userEvent.click(add);
  expect(screen.queryByRole("menu")).toBeNull();

  // What works instead: fork the thread from its last finished turn.
  await userEvent.click(within(panel).getByRole("button", { name: "Fork thread" }));
  expect(await screen.findByRole("dialog", { name: "Fork from here" })).toBeTruthy();
});

test("the launcher lists Side chat as not available yet, without a shortcut", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  expect(within(tools).getByRole("button", { name: /^Side chat/ }).textContent).toBe(
    "Side chatNot available yet",
  );
});
