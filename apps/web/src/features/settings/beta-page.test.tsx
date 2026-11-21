import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

const name = "New media pipeline";
const partial = "Only part of the new pipeline is on.";

// The switch can no longer be turned off: `media.encode` has no `legacy` since X2 (a stored one
// reads as `auto`), and nothing reads the setting any more. The switch goes with the settings in
// the media cleanup; until then it only reads as on.
test("encoding on reads as the whole pipeline on: there is no half-on any more", async () => {
  const app = harness();
  app.daemon.services.settings.write("media.encode", "auto");
  await app.open("/settings/beta");
  const toggle = await screen.findByRole("switch", { name });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(screen.queryByText(partial)).toBeNull();
});
