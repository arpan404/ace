import { workbench } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const title = "Dedupe thread events after reconnect";

async function openHome() {
  const app = harness();
  const dedupe = workbench().find((scenario) => scenario.thread.title === title);
  if (!dedupe) throw new Error(`workbench lost ${title}`);
  app.play(dedupe).runUntilBlocked();
  await app.open("/");
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  await within(nav).findAllByRole("link");
  return app;
}

test("a row's Snooze is an icon named by its tooltip, and still opens the snooze times", async () => {
  await openHome();
  const snooze = screen.getByRole("button", { name: `Snooze ${title}` });
  // No words on the button itself: the tooltip says what it does.
  expect(snooze.textContent).toBe("");
  await userEvent.hover(snooze);
  expect((await screen.findByRole("tooltip")).textContent).toBe("Snooze…");
  await userEvent.click(snooze);
  expect(await screen.findByRole("menuitem", { name: /^Tomorrow/ })).toBeTruthy();
});

test("a row's Pin says Pin thread, and Unpin thread once pinned", async () => {
  await openHome();
  const pin = screen.getByRole("button", { name: `Pin ${title}` });
  await userEvent.hover(pin);
  const tip = await screen.findByRole("tooltip");
  // The label, then the key that does the same on a focused row.
  expect(tip.textContent).toMatch(/^Pin thread/);
  expect(within(tip).getByText("P")).toBeTruthy();

  await userEvent.click(pin);
  const unpin = await screen.findByRole("button", { name: `Unpin ${title}` });
  await userEvent.unhover(unpin);
  await userEvent.hover(unpin);
  await waitFor(() => expect(screen.getByRole("tooltip").textContent).toMatch(/^Unpin thread/));
});
