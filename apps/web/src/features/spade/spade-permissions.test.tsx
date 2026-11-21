import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { spadeApp, withEndpoint } from "@/test/spade.ts";
import { permissionOf } from "./spade-permissions.tsx";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

test("a bot's permission follows the default for every bot until it is set for that bot", () => {
  expect(permissionOf("browser", {}, {})).toEqual({ on: true, own: false });
  expect(permissionOf("pay", {}, {})).toEqual({ on: false, own: false });
  expect(permissionOf("pay", {}, { pay: true })).toEqual({ on: true, own: false });
  expect(permissionOf("pay", { pay: false }, { pay: true })).toEqual({ on: false, own: true });
});

test("Permissions is its own tab, and a switch set there can go back to the default", async () => {
  await spadeApp("/spade/ivy?profile=permissions", (api) => {
    withEndpoint(api);
    api.addAgent({ id: "main", kind: "main", name: "Spade", avatar: { kind: "spade" } });
    api.addAgent({ id: "ivy", name: "Ivy", task: "Sort my inbox" });
  });
  const tab = await screen.findByRole("tab", { name: "Permissions" });
  expect(tab.getAttribute("aria-selected")).toBe("true");
  const panel = within(screen.getByRole("tabpanel"));
  const send = await panel.findByRole("switch", { name: "Send as you" });
  expect(send.getAttribute("aria-checked")).toBe("false");

  await userEvent.click(send);
  await waitFor(() => expect(send.getAttribute("aria-checked")).toBe("true"));
  const [back] = panel.getAllByRole("button", { name: "Use the default" });
  if (!back) throw new Error("Use the default shows once the switch is set");
  await userEvent.click(back);
  await waitFor(() =>
    expect(panel.getByRole("switch", { name: "Send as you" }).getAttribute("aria-checked")).toBe(
      "false",
    ),
  );
  expect(panel.queryByRole("button", { name: "Use the default" })).toBeNull();
});
