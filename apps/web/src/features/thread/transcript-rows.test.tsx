import { facts } from "@ace/fake-daemon";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());

function thinkThenEdit(app: ReturnType<typeof harness>) {
  app.daemon.createThread({ id: "rows", workspaceId: "ace", title: "Rows", provider: "claude" });
  app.daemon.apply("rows", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Tidy the loader"),
    {
      type: "item.upsert",
      agent: "root",
      item: "thought",
      draft: { type: "reasoning", complete: true, text: "The loader reads the config twice." },
    },
    facts.tool("root", "read-a", {
      kind: "file.read",
      title: "Read loader.ts",
      detail: { kind: "file.read", path: "src/loader.ts" },
    }),
    facts.toolDone("root", "read-a"),
    facts.tool("root", "read-b", {
      kind: "file.read",
      title: "Read config.ts",
      detail: { kind: "file.read", path: "src/config.ts" },
    }),
    facts.toolDone("root", "read-b"),
  ]);
}

test("a transcript row has no trailing caret and opens and closes from the keyboard", async () => {
  const app = harness();
  thinkThenEdit(app);
  await app.open("/t/rows");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  const group = await within(feed).findByRole("button", { name: /^Read 2 files and thought once/ });
  // Nothing after the title: no caret or arrow glyph on the right of the row.
  const lead = group.querySelector("[data-lead]");
  const glyphs = [...group.querySelectorAll("svg")];
  expect(glyphs.every((glyph) => lead?.contains(glyph))).toBe(true);
  expect(group.getAttribute("aria-expanded")).toBe("false");
  group.focus();
  await userEvent.keyboard("{Enter}");
  expect(group.getAttribute("aria-expanded")).toBe("true");
  expect(
    await within(feed).findByRole("list", { name: /Read 2 files and thought once/ }),
  ).toBeTruthy();
  await userEvent.keyboard(" ");
  expect(group.getAttribute("aria-expanded")).toBe("false");
  expect(within(feed).queryByRole("list", { name: /Read 2 files and thought once/ })).toBeNull();
});

test("a thought row leads with the brain and opens to its words from the keyboard", async () => {
  const app = harness();
  thinkThenEdit(app);
  await app.open("/t/rows");
  const feed = await screen.findByRole("feed", { name: "Transcript" });
  // The thought folds into the reads after it; opening their row shows it as a step.
  await userEvent.click(
    await within(feed).findByRole("button", { name: /^Read 2 files and thought once/ }),
  );
  const thought = await within(feed).findByRole("button", { name: /^Thought for/ });
  expect(thought.querySelector("[data-lead]")?.getAttribute("data-lead")).toBe("thought");
  expect(within(feed).queryByText("The loader reads the config twice.")).toBeNull();
  thought.focus();
  await userEvent.keyboard("{Enter}");
  expect(await within(feed).findByText("The loader reads the config twice.")).toBeTruthy();
});
