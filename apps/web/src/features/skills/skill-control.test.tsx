import { workbench, workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const catalog = () => screen.getByRole("navigation", { name: "Skills catalog" });
afterEach(() => localStorage.clear());
async function open(path: string) {
  const app = harness();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open(path);
  return app;
}

test("a skill switch changes only that skill and keeps its sibling enabled", async () => {
  const app = await open("/skills/engineering~skill~code-review");
  const control = await screen.findByRole("switch", { name: "Enabled" });
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByText("On")).toBeNull();
  await userEvent.click(control);
  await waitFor(() =>
    expect(within(catalog()).getByRole("link", { name: /Code review/ }).textContent).toContain(
      "Off",
    ),
  );
  expect(
    within(catalog()).getByRole("link", { name: /Test-driven development/ }).textContent,
  ).not.toContain("Off");
  const reply = await app.client.request({
    type: "pluginRequest",
    request: { type: "plugins.catalog" },
  });
  expect(reply.response).toMatchObject({
    components: expect.arrayContaining([
      expect.objectContaining({ name: "code-review", enabled: false }),
    ]),
  });
  await userEvent.click(control);
  await waitFor(() =>
    expect(within(catalog()).getByRole("link", { name: /Code review/ }).textContent).not.toContain(
      "Off",
    ),
  );
});

test("a skill keeps its own setting while its plugin is off and explains how to use it", async () => {
  await open("/skills/release~skill~release-notes");
  const control = await screen.findByRole("switch", { name: "Enabled" });
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("This plugin is off. Turn it on to use its skills.")).toBeTruthy();
  await userEvent.click(screen.getByRole("link", { name: "Release plugin" }));
  await userEvent.click(await screen.findByRole("switch", { name: "Enabled" }));
  await waitFor(() =>
    expect(
      within(catalog()).getByRole("link", { name: /Release notes/ }).textContent,
    ).not.toContain("Off"),
  );
});

test("skill provider choices leave its sibling and plugin provider choices alone", async () => {
  const app = await open("/skills/engineering~skill~code-review");
  await screen.findByRole("switch", { name: "Enabled" });
  await userEvent.click(screen.getByRole("button", { name: "Change" }));
  for (const name of ["Claude Code", "OpenCode", "Cursor", "Antigravity", "ACP agent", "Pi"])
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name }));
  await userEvent.keyboard("{Escape}");
  expect(await screen.findByText("Codex only")).toBeTruthy();
  const reply = await app.client.request({
    type: "pluginRequest",
    request: { type: "plugins.catalog" },
  });
  expect(reply.response).toMatchObject({
    components: expect.arrayContaining([
      expect.objectContaining({ name: "code-review", providers: ["codex"] }),
      expect.objectContaining({
        name: "tdd",
        providers: expect.arrayContaining(["claude", "codex"]),
      }),
    ]),
  });
});

test("a rejected skill change keeps the saved state and explains how to retry", async () => {
  const app = await open("/skills/engineering~skill~code-review");
  const control = await screen.findByRole("switch", { name: "Enabled" });
  app.daemon.failRequests("pluginRequest");
  await userEvent.click(control);
  expect(
    await screen.findAllByText(
      "Couldn't save the change. Check your connection and try again.",
      {},
      { timeout: 4000 },
    ),
  ).toBeTruthy();
  expect(control.getAttribute("aria-checked")).toBe("true");
  app.daemon.restoreRequests();
});

test("the preview renders headings, lists and links while keeping package metadata out of the instructions", async () => {
  const app = harness();
  const services = workbenchServices(Date.now());
  const component = services.plugins?.installed?.[0]?.components[0];
  if (!component) throw new Error("Expected a skill fixture");
  component.text =
    "---\nname: code-review\ndescription: Hidden package metadata\n---\n# Review instructions\n\n- Check the behavior\n- Read [the reference](https://example.com/reference)\n";
  app.daemon.seedServices(services);
  await app.open("/skills/engineering~skill~code-review");
  const preview = within(await screen.findByRole("region", { name: "Source" }));
  expect(await preview.findByRole("heading", { name: "Review instructions" })).toBeTruthy();
  expect(preview.getAllByRole("listitem")[0]?.textContent).toContain("Check the behavior");
  expect(preview.getByRole("link", { name: "the reference" }).getAttribute("href")).toBe(
    "https://example.com/reference",
  );
  expect(preview.queryByText(/Hidden package metadata/)).toBeNull();
});

test("Use in a thread opens an editable skill draft and sends the invocation when submitted", async () => {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  app.daemon.seedServices(workbenchServices(Date.now()));
  await app.open("/skills/engineering~skill~code-review");
  await userEvent.click(await screen.findByRole("link", { name: "Use in a thread" }));
  await screen.findByRole("heading", { level: 1, name: "New thread" });
  const field = await screen.findByRole("combobox", { name: "Message" });
  expect(field.textContent).toBe("/code-review ");
  await userEvent.type(field, "Review the reconnect change{Enter}");
  await screen.findByRole("heading", {
    level: 1,
    name: "/code-review Review the reconnect change",
  });
  await waitFor(() => {
    const view = app.daemon.snapshot({ kind: "threads" });
    expect(
      view?.kind === "threads" &&
        Object.values(view.threads).some(
          (thread) => thread.title === "/code-review Review the reconnect change",
        ),
    ).toBe(true);
  });
});
