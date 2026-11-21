import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const name = "New media pipeline";
const partial = "Only part of the new pipeline is on.";

function stored(app: ReturnType<typeof harness>) {
  const settings = app.daemon.services.settings;
  return { encode: settings.get("media.encode"), delivery: settings.get("media.delivery") };
}

test("turning the new media pipeline on routes encoding through ace-media; delivery is ace-media's already", async () => {
  const app = harness();
  await app.open("/settings/beta");
  const toggle = await screen.findByRole("switch", { name });
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await userEvent.click(toggle);

  await waitFor(() => expect(stored(app)).toEqual({ encode: "auto", delivery: "auto" }));
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

test("turning it off puts encoding back on the current pipeline, and delivery stays ace-media's", async () => {
  const app = harness();
  app.daemon.services.settings.write("media.encode", "auto");
  await app.open("/settings/beta");
  const toggle = await screen.findByRole("switch", { name });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

  await userEvent.click(toggle);

  await waitFor(() => expect(stored(app)).toEqual({ encode: "legacy", delivery: "auto" }));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});

test("encoding on reads as the whole pipeline on: there is no half-on any more", async () => {
  const app = harness();
  app.daemon.services.settings.write("media.encode", "auto");
  await app.open("/settings/beta");
  const toggle = await screen.findByRole("switch", { name });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(screen.queryByText(partial)).toBeNull();
});

test("a save the daemon refuses says so in the row and the switch keeps the stored state", async () => {
  const app = harness();
  await app.open("/settings/beta");
  const toggle = await screen.findByRole("switch", { name });
  app.daemon.failRequests("settings.set");

  await userEvent.click(toggle);

  const row = document.getElementById("beta.mediaPipeline");
  if (!row) throw new Error("the row is missing");
  expect((await within(row).findByRole("alert")).textContent).toMatch(
    /^Couldn't turn the new media pipeline on/,
  );
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  expect(stored(app)).toEqual({ encode: "legacy", delivery: "auto" });
});
