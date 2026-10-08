import { coldStartReplay } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("the launcher offers working tools without Side chat", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(within(panel).getByRole("button", { name: "New tab" }));
  const tools = await within(panel).findByRole("list", { name: "Tools" });
  expect(within(tools).getByRole("button", { name: /^Files/ })).toBeTruthy();
  expect(within(tools).queryByRole("button", { name: /Side chat/ })).toBeNull();
  await userEvent.keyboard("{Escape}{Alt>}{Meta>}s{/Meta}{/Alt}");
  expect(within(panel).queryByRole("tab", { name: "Side chat" })).toBeNull();
});
