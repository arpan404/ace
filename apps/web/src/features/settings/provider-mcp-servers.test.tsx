import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

async function claudeServers() {
  return screen.findByRole("list", { name: "Claude Code MCP servers" });
}
const row = (list: HTMLElement, name: string) => {
  const item = within(list)
    .getAllByRole("listitem")
    .find((candidate) => within(candidate).queryByText(name));
  if (!item) throw new Error(`No ${name} row`);
  return item;
};

test("a server waiting for its own sign-in reads Not signed in calmly, and Claude still reads ready", async () => {
  const app = harness();
  app.daemon.mcp.servers.set("claude", [
    { name: "github", status: "connected" },
    { name: "vercel", status: "needs_auth" },
  ]);
  await app.open("/settings/providers/claude");
  const list = await claudeServers();
  const vercel = await waitFor(() => row(list, "vercel"));
  expect(await within(vercel).findByText("Not signed in")).toBeTruthy();
  expect(within(row(list, "github")).getByText("Connected")).toBeTruthy();
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
  expect(screen.queryByText("Needs attention")).toBeNull();
  expect(screen.queryByText("Sign in needed")).toBeNull();
  expect((await screen.findAllByText("Signed in as ada@example.com")).length).toBeGreaterThan(0);
});

test("Reconnect, Turn off and Turn on change a server through the daemon", async () => {
  const app = harness();
  app.daemon.mcp.servers.set("claude", [{ name: "vercel", status: "needs_auth" }]);
  await app.open("/settings/providers/claude");
  const list = await claudeServers();
  await within(list).findByText("Not signed in");
  await userEvent.click(within(list).getByRole("button", { name: "Reconnect vercel" }));
  expect(await within(list).findByText("Connected")).toBeTruthy();
  await userEvent.click(within(list).getByRole("button", { name: "Turn off vercel" }));
  expect(await within(list).findByText("Off")).toBeTruthy();
  await userEvent.click(within(list).getByRole("button", { name: "Turn on vercel" }));
  expect(await within(list).findByText("Connected")).toBeTruthy();
  expect(app.daemon.mcp.servers.get("claude")).toEqual([{ name: "vercel", status: "connected" }]);
});

test("Add MCP server saves it and keeps the existing servers", async () => {
  const app = harness();
  app.daemon.mcp.servers.set("claude", [{ name: "vercel", status: "connected" }]);
  await app.open("/settings/providers/claude");
  const list = await claudeServers();
  await userEvent.click(await within(list).findByRole("button", { name: "Add MCP server" }));
  const dialog = await screen.findByRole("dialog", { name: "Add MCP server" });
  await userEvent.type(within(dialog).getByLabelText("Name"), "docs");
  await userEvent.type(within(dialog).getByLabelText("Command"), "docs-mcp");
  await userEvent.click(within(dialog).getByRole("button", { name: "Add server" }));
  expect(await within(list).findByText("docs")).toBeTruthy();
  expect(within(list).getByText("vercel")).toBeTruthy();
});

test("with no live Claude session the page says where the servers come from, without a warning", async () => {
  const app = harness();
  app.daemon.mcp.idle.add("claude");
  await app.open("/settings/providers/claude");
  expect(
    await screen.findByText(
      "Claude Code's MCP servers show here while one of its threads is running.",
    ),
  ).toBeTruthy();
  expect(within(await claudeServers()).queryAllByRole("listitem")).toHaveLength(0);
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});
