import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const name = "New media pipeline";

function stored(app: ReturnType<typeof harness>) {
  return { delivery: app.daemon.services.settings.get("media.delivery") };
}

test("turning the new media pipeline on routes delivery through ace-media", async () => {
  const app = harness();
  await app.open("/settings/beta");
  const toggle = await screen.findByRole("switch", { name });
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await userEvent.click(toggle);

  await waitFor(() => expect(stored(app)).toEqual({ delivery: "auto" }));
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

test("turning it off puts delivery back on the daemon", async () => {
  const app = harness();
  app.daemon.services.settings.write("media.delivery", "auto");
  await app.open("/settings/beta");
  const toggle = await screen.findByRole("switch", { name });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));

  await userEvent.click(toggle);

  await waitFor(() => expect(stored(app)).toEqual({ delivery: "legacy" }));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
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
  expect(stored(app)).toEqual({ delivery: "legacy" });
});
