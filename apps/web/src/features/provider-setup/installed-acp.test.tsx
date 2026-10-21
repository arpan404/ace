import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

// These cases exercise fresh controller state after the provider screens have loaded.
await Promise.all([
  import("../settings/providers-page.tsx"),
  import("../settings/provider-detail.tsx"),
]);

test.each(["list", "detail"])(
  "a fresh installed ACP agent with unknown authentication can sign in from its %s",
  async (surface) => {
    const app = harness();
    for (const account of app.daemon.services.accounts) {
      if (account.provider === "acp") {
        account.quota.auth = "unknown";
        account.availability = "unknown";
      }
    }
    app.daemon.services.models = app.daemon.services.models.filter(
      (model) => model.provider !== "acp",
    );
    await app.open("/settings/providers");
    const row = await screen.findByRole("group", { name: "Gemini CLI" });
    if (surface === "detail") {
      await userEvent.click(within(row).getByRole("link", { name: "Gemini CLI" }));
      await screen.findByRole("heading", { name: "Gemini CLI", level: 2 });
    }
    const owner = surface === "list" ? row : screen.getByRole("main");
    await userEvent.click(
      await within(owner).findByRole("button", { name: "Sign in to Gemini CLI" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Sign in to Gemini CLI" });
    expect(await within(dialog).findByRole("link", { name: "Open sign-in page" })).toBeTruthy();
  },
);
