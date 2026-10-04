import { coldStartReplay } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("Side chat has the thread composer's shape, switched off, with the reason attached", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Alt>}{Meta>}s{/Meta}{/Alt}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { name: "Side chat", selected: true })).toBeTruthy();

  const box = await within(panel).findByRole("combobox", { name: "Side chat message" });
  expect(box.hasAttribute("disabled")).toBe(true);
  const reason = document.getElementById(box.getAttribute("aria-describedby") ?? "");
  expect(reason?.textContent).toBe(
    "This daemon can't start side chats yet. Fork the thread to explore without changing it.",
  );
  // The same send button as the thread's composer, saying why it can't send.
  const send = within(panel).getByRole("button", { name: "Send" });
  expect(send.getAttribute("aria-disabled")).toBe("true");
});
