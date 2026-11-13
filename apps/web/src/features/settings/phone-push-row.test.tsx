import { configure, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

await import("./notifications-page.tsx");

const title = "Push when the app is closed";

test("phone push is on until turned off, and turning it off saves it on this machine", async () => {
  const app = harness();
  await app.open("/settings/notifications");
  const toggle = await screen.findByRole("switch", { name: title });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(screen.getByText(/ace's push service, which sees only encrypted data/)).toBeTruthy();

  await userEvent.click(toggle);
  await waitFor(() =>
    expect(app.daemon.services.settings.get("notifications.remotePush")).toBe(false),
  );
  expect(screen.getByRole("switch", { name: title }).getAttribute("aria-checked")).toBe("false");
});

test("phone push shows the value this machine saved", async () => {
  const app = harness();
  app.daemon.services.settings.seed({ "notifications.remotePush": false });
  await app.open("/settings/notifications");
  const toggle = await screen.findByRole("switch", { name: title });
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
});
