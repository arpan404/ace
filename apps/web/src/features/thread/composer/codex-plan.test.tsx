import { longHistory, workbench } from "@ace/fake-daemon";
import { configure, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { chooseModel, closeModelControl } from "@/test/model-control.ts";

configure({ asyncUtilTimeout: 30000 });

test.each(["new", "existing"])(
  "Codex never offers an unsupported Plan permission on %s threads",
  async (where) => {
    const app = harness();
    if (where === "new") {
      for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
      await app.open("/new?project=relay");
      await chooseModel("GPT-6.1 Sol", "Codex");
      await closeModelControl();
    } else {
      const scenario = longHistory(2);
      scenario.thread.provider = "codex";
      app.play(scenario).runUntilBlocked();
      await app.open("/t/thread-router");
    }
    await screen.findByRole("combobox", { name: "Message" });
    await userEvent.click(screen.getByRole("button", { name: "Add files and context" }));
    const menu = await screen.findByRole("listbox", { name: "Add" });
    expect(within(menu).getByRole("option", { name: /Attach files/ })).toBeTruthy();
    expect(within(menu).queryByRole("option", { name: /Plan mode/ })).toBeNull();
  },
);
