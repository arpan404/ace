import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { deviceBrowser, openDevice, openDevices } from "@/test/device-browser.ts";

const iphoneId = "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b";
let browser: ReturnType<typeof deviceBrowser>;
beforeEach(() => {
  browser = deviceBrowser("none");
});
afterEach(() => {
  browser.restore();
  vi.restoreAllMocks();
});

/** The iPhone's tab with its screen live, handed to one of the thread's agents. */
async function agentDriving() {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });
  await userEvent.click(within(iphone).getByRole("button", { name: "Delegate to an agent" }));
  const agent = (await screen.findAllByRole("menuitem"))[0];
  const name = agent?.textContent ?? "";
  await userEvent.click(agent!);
  await within(iphone).findByText(name);
  return { app, iphone, name };
}

test("an agent's tap shows on the stage as a ripple and a caption naming the element, which then fades", async () => {
  const { app, iphone } = await agentDriving();
  expect(within(iphone).queryByRole("status", { name: "Agent action" })).toBeNull();

  act(() =>
    app.daemon.appDevices.agentActs(iphoneId, {
      action: "press",
      point: { x: 195, y: 422 },
      ref: "e7",
      label: "Sign in",
    }),
  );

  const caption = await within(iphone).findByRole("status", { name: "Agent action" });
  expect(caption.textContent).toBe("tap @e7 “Sign in”");
  expect(iphone.querySelector("[data-activity-ripple]")).not.toBeNull();
  await waitFor(
    () => expect(within(iphone).queryByRole("status", { name: "Agent action" })).toBeNull(),
    { timeout: 4000 },
  );
  expect(iphone.querySelector("[data-activity-ripple]")).toBeNull();
});

test("what an agent did before the device's tab opened isn't replayed", async () => {
  const { app, panel } = await openDevices();
  await userEvent.click(await within(panel).findByRole("button", { name: "Enable devices" }));
  app.daemon.appDevices.agentActs(iphoneId, { action: "tap", point: { x: 10, y: 10 } });

  const iphone = await openDevice(panel, "iPhone 16 Pro");
  await within(iphone).findByRole("img", { name: "iPhone 16 Pro screen" });
  expect(within(iphone).queryByRole("status", { name: "Agent action" })).toBeNull();
});

test("the UI tree lists the refs agents read, and hovering one outlines it on the screen", async () => {
  const { iphone } = await agentDriving();
  await userEvent.click(within(iphone).getByRole("button", { name: "UI tree" }));

  const tree = await within(iphone).findByRole("tree", { name: "UI tree" });
  const signIn = within(tree).getByRole("treeitem", { name: "@e7 Button Sign in" });
  expect(iphone.querySelector("[data-bounds-outline]")).toBeNull();
  await userEvent.hover(within(signIn).getByText("Sign in"));
  expect(iphone.querySelector("[data-bounds-outline]")).not.toBeNull();
  await userEvent.unhover(within(signIn).getByText("Sign in"));
  expect(iphone.querySelector("[data-bounds-outline]")).toBeNull();
});

test("taking over from an agent makes the rail usable and its keys reach the device", async () => {
  const { app, iphone, name } = await agentDriving();
  expect(within(iphone).getByRole("button", { name: "Home" }).getAttribute("aria-disabled")).toBe(
    "true",
  );

  await userEvent.click(within(iphone).getByRole("button", { name: /Take over/ }));
  expect(await within(iphone).findByRole("status", { name: "You're in control" })).toBeTruthy();
  expect(within(iphone).queryByText(name)).toBeNull();
  await userEvent.click(within(iphone).getByRole("button", { name: "Rotate" }));
  await waitFor(() =>
    expect(app.daemon.appDevices.inputs.map((entry) => entry.input)).toEqual([
      { kind: "key", key: "rotate" },
    ]),
  );
});
