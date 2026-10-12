import { expect, it } from "vitest";
import { ComposerDraft } from "./composer-draft.ts";

it("keeps text edited while the original send is still saving", async () => {
  const persisted: string[] = [];
  const saved = Promise.withResolvers<void>();
  const draft = new ComposerDraft(async (text) => {
    await saved.promise;
    persisted.push(text);
  });
  draft.edit("Original instruction");
  const sending = draft.send();
  draft.edit("New instruction typed while saving");
  saved.resolve();
  await sending;
  expect(persisted).toEqual(["Original instruction"]);
  expect(draft.selection.getSnapshot().text).toBe("New instruction typed while saving");
});
it("keeps a revised draft even when it matches the submitted text", async () => {
  const saved = Promise.withResolvers<void>();
  const draft = new ComposerDraft(() => saved.promise);
  draft.edit("Original");
  const sending = draft.send();
  draft.edit("Changed");
  draft.edit("Original");
  saved.resolve();
  await sending;
  expect(draft.selection.getSnapshot().text).toBe("Original");
});
it("clears only an unedited draft after it is saved", async () => {
  const saved = Promise.withResolvers<void>();
  const draft = new ComposerDraft(() => saved.promise);
  draft.edit("Original");
  const sending = draft.send();
  expect(draft.selection.getSnapshot().text).toBe("Original");
  saved.resolve();
  await sending;
  expect(draft.selection.getSnapshot().text).toBe("");
});
it("preserves the latest text when persistence fails", async () => {
  const saved = Promise.withResolvers<void>();
  const draft = new ComposerDraft(() => saved.promise);
  draft.edit("Original");
  const sending = draft.send();
  draft.edit("New instruction");
  saved.reject(new Error("Disk full"));
  await expect(sending).rejects.toThrow("Disk full");
  expect(draft.selection.getSnapshot().text).toBe("New instruction");
});
