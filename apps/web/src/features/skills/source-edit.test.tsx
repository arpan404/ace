import { workbenchServices } from "@ace/fake-daemon";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
const path = "skills/code-review/SKILL.md";
async function setup(text: string) {
  const app = harness({ throughWorker: true });
  const seed = workbenchServices(1000);
  const component = seed.plugins?.installed?.[0]?.components[0];
  if (!component) throw new Error("Missing skill fixture");
  component.text = text;
  app.daemon.seedServices(seed);
  await app.open("/skills/engineering~skill~code-review");
  await screen.findByRole("button", { name: "Edit" });
  return app;
}
async function acceptedSource(app: ReturnType<typeof harness>) {
  const response = (
    await app.client.request({
      type: "pluginRequest",
      request: { type: "plugins.source", name: "engineering", path },
    })
  ).response;
  if (response.type !== "plugins.source") throw new Error("Missing source");
  return response.text;
}
test("a source longer than 64 KiB opens and edits its final page without losing Unicode", async () => {
  const text = "# Review\n" + "é".repeat(40000) + "\nThe last page.";
  await setup(text);
  expect(await screen.findByText(/The last page\./)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Source text" }).value).toBe(
    text,
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("textbox", { name: "Source text" })).toBeNull();
});
test("saved source stays unchanged until acceptance and Back keeps the draft", async () => {
  const app = await setup("# Before\nOriginal instructions");
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const textbox = screen.getByRole("textbox", { name: "Source text" });
  await userEvent.clear(textbox);
  await userEvent.type(textbox, "# After\nReviewed instructions");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  let review = await screen.findByRole("dialog");
  expect(await acceptedSource(app)).toContain("Original instructions");
  await userEvent.click(within(review).getByRole("button", { name: "Back" }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Source text" }).value).toContain(
    "Reviewed instructions",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  review = await screen.findByRole("dialog");
  await userEvent.click(within(review).getByRole("button", { name: "Accept changes" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Source text" })).toBeNull());
  expect(await acceptedSource(app)).toContain("Reviewed instructions");
  const response = (
    await app.client.request({ type: "pluginRequest", request: { type: "plugins.list" } })
  ).response;
  if (response.type !== "plugins.list") throw new Error("Missing plugins");
  expect(response.reviews).toEqual([]);
});

test("a changed source cannot overwrite the accepted file and the draft stays available", async () => {
  const app = await setup("# Original instructions");
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const textbox = screen.getByRole("textbox", { name: "Source text" });
  await userEvent.clear(textbox);
  await userEvent.type(textbox, "My draft");
  const source = (
    await app.client.request({
      type: "pluginRequest",
      request: { type: "plugins.source", name: "engineering", path },
    })
  ).response;
  if (source.type !== "plugins.source") throw new Error("Missing source");
  const prepared = (
    await app.client.request({
      type: "pluginRequest",
      request: {
        type: "plugins.edit",
        name: "engineering",
        path,
        expectedHash: source.hash,
        text: "Changed elsewhere",
      },
    })
  ).response;
  if (prepared.type !== "plugins.review") throw new Error("Missing review");
  await app.client.request({
    type: "pluginRequest",
    request: {
      type: "plugins.accept",
      id: prepared.review.id,
      commit: prepared.review.commit,
      hash: prepared.review.hash,
    },
  });
  // Changing availability refreshes the source while the existing draft stays open.
  await userEvent.click(screen.getByRole("switch", { name: "Turn engineering on or off" }));
  await screen.findByRole("switch", { name: "Turn engineering on or off", checked: false });
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("Couldn't save this source"),
  );
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Source text" }).value).toBe(
    "My draft",
  );
  expect(await acceptedSource(app)).toBe("Changed elsewhere");
  await userEvent.click(screen.getByRole("button", { name: "Reload source" }));
  expect(await screen.findByText("Changed elsewhere")).toBeTruthy();
});
