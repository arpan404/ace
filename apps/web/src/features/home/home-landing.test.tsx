import { workbench } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

test("Home opens on the top thread, then comes back to the thread last opened", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  await app.open("/");
  // The list's first row opens, and it is a thread that needs you.
  const threads = await screen.findByRole("navigation", { name: "Threads" });
  const [top] = await within(threads).findAllByRole("link");
  const title = (await screen.findAllByRole("heading", { level: 1 })).find(
    (heading) => heading.textContent !== "Home",
  );
  expect(title?.textContent).toBeTruthy();
  expect(top?.textContent).toContain(title?.textContent);
  expect(top?.getAttribute("aria-current")).toBe("page");

  await userEvent.click(within(threads).getByRole("link", { name: /Backpressure/ }));
  await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" });

  const rail = screen.getByRole("navigation", { name: "Views" });
  const sidebarTop = screen.getByRole("navigation", { name: "App" });
  await userEvent.click(within(sidebarTop).getByRole("link", { name: /^Activity/ }));
  await screen.findByRole("heading", { level: 1, name: "Activity" });
  await userEvent.click(within(rail).getByRole("link", { name: /^Home/ }));
  expect(
    await screen.findByRole("heading", { level: 1, name: "Backpressure on broadcast fan-out" }),
  ).toBeTruthy();
});

test("with no threads at all, Home says how to start one", async () => {
  await harness().open("/");
  expect(await within(await screen.findByRole("main")).findByText("No threads yet")).toBeTruthy();
});
