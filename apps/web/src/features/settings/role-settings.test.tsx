import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { chooseSource } from "@/test/model-control.ts";
import { harness } from "@/test/harness.tsx";

// Agents' lazy body must be transformed before the first interaction's deadline starts.
await import("./agents-page.tsx");
configure({ asyncUtilTimeout: 10000 });
beforeEach(() => localStorage.clear());

const review = () => screen.findByRole("button", { name: /^Review:/ });

test(
  "a role starts not set, a picked model and effort are saved on the daemon, and Not set clears it",
  { timeout: 30_000 },
  async () => {
    const app = harness();
    const { settings } = app.daemon.services;
    await app.open("/settings/agents");
    expect((await review()).getAttribute("aria-label")).toBe("Review: Not set");
    expect(screen.queryByRole("combobox", { name: "Review effort" })).toBeNull();

    await userEvent.click(await review());
    const picker = await screen.findByRole("dialog", { name: "Review" });
    await chooseSource(picker, "Claude Code · Personal");
    await userEvent.type(
      within(picker).getByRole("combobox", { name: "Search models" }),
      "Opus 4.8",
    );
    const [opus] = await within(picker).findAllByRole("option", { name: /^Opus 4\.8,/ });
    if (!opus) throw new Error("No Opus 4.8");
    await userEvent.click(opus);
    await waitFor(() => {
      expect(settings.get("providers.reviewer.provider")).toBe("claude");
      expect(settings.get("providers.reviewer.model")).toBe("claude-opus-4-8");
    });
    await waitFor(async () =>
      expect((await review()).getAttribute("aria-label")).toBe("Review: Opus 4.8"),
    );

    await userEvent.click(await screen.findByRole("combobox", { name: "Review effort" }));
    await userEvent.click(await screen.findByRole("option", { name: "XHigh" }));
    await waitFor(() => expect(settings.get("providers.reviewer.reasoningEffort")).toBe("xhigh"));

    await userEvent.click(await review());
    await userEvent.click(
      within(await screen.findByRole("dialog", { name: "Review" })).getByRole("button", {
        name: "Not set",
      }),
    );
    await waitFor(() => expect(settings.get("providers.reviewer.provider")).toBeNull());
    await waitFor(async () =>
      expect((await review()).getAttribute("aria-label")).toBe("Review: Not set"),
    );
  },
);
