import { coldStartReplay } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("Side chat says the daemon can't run one, with its composer off and the reason attached", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Alt>}{Meta>}s{/Meta}{/Alt}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(within(panel).getByRole("tab", { name: "Side chat", selected: true })).toBeTruthy();

  const box = await within(panel).findByRole("textbox", { name: "Side chat message" });
  expect(box.hasAttribute("disabled")).toBe(true);
  const reason = document.getElementById(box.getAttribute("aria-describedby") ?? "");
  expect(reason?.textContent).toContain("no way to start a temporary conversation beside a thread");
  expect(within(panel).getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
});
