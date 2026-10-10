import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { WorkspaceId } from "@ace/protocol";
import { workbench } from "@ace/fake-daemon";
import { harness } from "@/test/harness.tsx";

test("project search keeps draft text, supports keyboard selection, no matches and Add project", async () => {
  const app = harness();
  for (const example of workbench()) app.play(example).runUntilBlocked();
  await app.open("/new?project=ace");
  const message = await screen.findByRole("combobox", { name: "Message" });
  await userEvent.type(message, "Keep my draft");
  await userEvent.click(await screen.findByRole("button", { name: "Project: ace" }));
  const popup = await screen.findByRole("dialog", { name: "Choose project" });
  const search = await within(popup).findByRole("combobox", { name: "Search projects" });
  expect(document.activeElement).toBe(search);
  await userEvent.type(search, "RELAY");
  expect(within(popup).getAllByRole("option")).toHaveLength(1);
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await screen.findByRole("button", { name: "Project: relay" });
  expect(message.textContent).toBe("Keep my draft");
  await userEvent.click(screen.getByRole("button", { name: "Project: relay" }));
  const reopened = await screen.findByRole("dialog", { name: "Choose project" });
  await userEvent.type(
    await within(reopened).findByRole("combobox", { name: "Search projects" }),
    "not-a-project",
  );
  expect(await within(reopened).findByText("No projects match.")).toBeTruthy();
  expect(within(reopened).getByRole("button", { name: "Add project" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Choose project" })).toBeNull();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Project: relay");
});

test("the picker uses configured artwork and the shared initials fallback", async () => {
  const app = harness();
  for (const example of workbench()) app.play(example).runUntilBlocked();
  await app.open("/new?project=ace");
  await app.client.command({
    type: "workspace.update",
    workspaceId: WorkspaceId.parse("ace"),
    name: "Application",
    icon: "https://example.com/ace.png",
  });
  await userEvent.click(await screen.findByRole("button", { name: "Project: Application" }));
  const popup = await screen.findByRole("dialog", { name: "Choose project" });
  const ace = within(popup).getByRole("option", { name: "Application" });
  const image = ace.querySelector("img");
  expect(image?.getAttribute("src")).toBe("https://example.com/ace.png");
  const path = app.daemon.projects.list().workspaces.find((project) => project.id === "ace")?.path;
  if (!path) throw new Error("Missing project path");
  await userEvent.type(
    await within(popup).findByRole("combobox", { name: "Search projects" }),
    path,
  );
  expect(within(popup).queryByRole("option", { name: "relay" })).toBeNull();
  expect(within(popup).getByRole("option", { name: "Application" })).toBeTruthy();
  await userEvent.clear(await within(popup).findByRole("combobox", { name: "Search projects" }));
  expect(within(popup).getByRole("option", { name: "relay" }).textContent).toContain("RE");
});
