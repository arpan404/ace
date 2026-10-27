import { describe, expect, it } from "vitest";
import { projectDefaultModels, projectEdit, projectIconChoice } from "./project-edit.ts";

const project = {
  name: "web-app",
  icon: null,
  badge: { color: "blue" as const },
  defaults: { access: "ask" as const, worktree: true },
  notes: [{ id: "n1", text: "tests use bun run test", createdAt: 1 }],
};

describe("saving Edit project", () => {
  it("closes without sending when nothing differs from the project", () => {
    expect(
      projectEdit(project, {
        name: " web-app ",
        icon: projectIconChoice(project),
        defaults: { worktree: true, access: "ask" },
        notes: [{ id: "n1", text: "tests use bun run test  " }],
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("sends a rename alone when only the name changed", () => {
    expect(projectEdit(project, { name: "Storefront" })).toEqual({
      kind: "edit",
      edit: { name: "Storefront" },
    });
  });

  it("refuses a name the daemon would refuse, with the reason", () => {
    const result = projectEdit(project, { name: "a/b" });
    expect(result).toEqual({ kind: "invalid", problem: "A name can't contain / or \\." });
  });

  it("switching to a glyph keeps the chosen colour and clears any image", () => {
    const choice = {
      ...projectIconChoice(project),
      mode: "glyph" as const,
      glyph: "rocket" as const,
    };
    expect(projectEdit(project, { name: "web-app", icon: choice })).toEqual({
      kind: "edit",
      edit: { name: "web-app", icon: null, badge: { color: "blue", glyph: "rocket" } },
    });
  });

  it("Auto returns to the found favicon or initials", () => {
    const choice = { ...projectIconChoice(project), mode: "auto" as const };
    expect(projectEdit(project, { name: "web-app", icon: choice })).toMatchObject({
      edit: { icon: null, badge: null },
    });
  });

  it("image mode with no image picked yet changes nothing", () => {
    const choice = { ...projectIconChoice(project), mode: "image" as const };
    expect(projectEdit(project, { name: "web-app", icon: choice })).toEqual({ kind: "unchanged" });
  });

  it("saves a picked image and drops the badge", () => {
    const image = "data:image/png;base64,AAAA";
    const choice = { ...projectIconChoice(project), mode: "image" as const, image };
    expect(projectEdit(project, { name: "web-app", icon: choice })).toMatchObject({
      edit: { icon: image, badge: null },
    });
  });

  it("replaces the defaults when one of them changed", () => {
    const defaults = { access: "full-access" as const, worktree: true };
    expect(projectEdit(project, { name: "web-app", defaults })).toEqual({
      kind: "edit",
      edit: { name: "web-app", defaults },
    });
  });

  it("drops cleared notes and keeps edited ones by id", () => {
    const notes = [
      { id: "n1", text: "tests use bun run test, never bun test" },
      { text: "   " },
      { text: "deploys go through CI" },
    ];
    expect(projectEdit(project, { name: "web-app", notes })).toEqual({
      kind: "edit",
      edit: {
        name: "web-app",
        notes: [
          { id: "n1", text: "tests use bun run test, never bun test" },
          { text: "deploys go through CI" },
        ],
      },
    });
  });
});

describe("a project's default model choices", () => {
  it("lists each provider's model once, without legacy ones, keeping a saved one", () => {
    const models = [
      { provider: "codex" as const, id: "gpt-6", label: "GPT-6", legacy: false },
      { provider: "codex" as const, id: "gpt-6", label: "GPT-6", legacy: false },
      { provider: "codex" as const, id: "gpt-4", label: "GPT-4", legacy: true },
    ];
    expect(projectDefaultModels(models, { provider: "claude", model: "old-model" })).toEqual([
      { provider: "codex", id: "gpt-6", label: "GPT-6" },
      { provider: "claude", id: "old-model", label: "old-model" },
    ]);
  });
});
