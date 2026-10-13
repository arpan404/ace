import { coldStartReplay, facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { act, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
import { panelServices } from "../services.ts";
import { discardDraft, saveDraft } from "./drafts.ts";
import { persistReview } from "./review-store.ts";

configure({ asyncUtilTimeout: 10000 });
const threadId = ThreadId.parse("thread-cold-start");
const path = "review-composition.ts";
const historical = "header\nconst a = 1;\nfooter\n";
const current = "header\nconst b = 2;\nfooter\n";
const base = "header\nconst initial = 0;\nfooter\n";

function edit(id: string, text: string) {
  return [
    { ...facts.turn("root"), nativeTurnId: id },
    facts.tool("root", id, {
      kind: "file.edit",
      title: "Edit review fixture",
      detail: {
        kind: "file.edit",
        changes: [{ path, kind: "update" as const, oldText: base, newText: text }],
      },
    }),
    facts.toolDone("root", id),
    { ...facts.endTurn("root"), nativeTurnId: id },
  ];
}
async function openChanges(app = harness()) {
  app.play(coldStartReplay()).runThrough("test-done");
  app.daemon.apply(threadId, edit("historical", historical));
  app.daemon.apply(threadId, edit("current", current));
  const mounted = await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await app.client.request({
    type: "files.request",
    threadId,
    operation: { op: "create", path, expected: null, text: current },
  });
  const restoredPanel = screen.queryByRole("region", { name: "Thread panel" });
  if (restoredPanel) {
    await userEvent.click(within(restoredPanel).getByRole("tab", { name: /^Changes/ }));
  } else {
    await screen.findByRole("button", { name: "Right panel" }, { timeout: 10000 });
    await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  }
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("region", { name: path });
  return { app, panel, mounted };
}

test("a saved-comment editor in another tab cannot revive a discarded comment after storage reconciliation", async () => {
  const shared = memoryKeyValue();
  const storageA = { ...shared };
  const storageB = { ...shared };
  const a = await openChanges(harness({ storage: storageA }));
  const blockA = within(a.panel).getByRole("region", { name: path });
  await begin(blockA, "Discard this finding", "const b = 4;");
  await userEvent.click(within(blockA).getByRole("button", { name: "Comment" }));
  const servicesA = await panelServices(a.app.client);
  const target = servicesA.drafts.get().find((draft) => draft.text === "Discard this finding");
  if (!target) throw new Error("Missing saved finding");
  a.mounted.unmount();

  const appB = harness({ storage: storageB });
  const servicesB = await panelServices(appB.client);
  let reconcile: (() => void) | undefined;
  persistReview(servicesB, storageB, (changed) => {
    reconcile = changed;
  });
  const b = await openChanges(appB);
  const blockB = within(b.panel).getByRole("region", { name: path });
  await userEvent.click(within(blockB).getByRole("button", { name: "Edit" }));
  const editing = within(blockB).getByRole("textbox", { name: "Comment on line 2" });
  await userEvent.clear(editing);
  await userEvent.type(editing, "Unsaved edit in B");
  // Independent storage views deliver cross-tab changes only when their subscription fires.
  discardDraft(servicesA.drafts, target.key);
  saveDraft(servicesA.drafts, { ...target, key: "unrelated", text: "Keep the unrelated finding" });
  await act(() => {
    if (!reconcile) throw new Error("No storage subscription");
    reconcile();
  });
  await waitFor(() =>
    expect(within(blockB).queryByRole("textbox", { name: "Comment on line 2" })).toBeNull(),
  );
  expect(within(b.panel).queryByRole("button", { name: /Resume .*Unsaved edit in B/ })).toBeNull();
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
  await userEvent.click(within(blockB).getByRole("button", { name: "Comment on line 2" }));
  expect(within(blockB).getByRole("textbox", { name: "Comment on line 2" })).toHaveProperty(
    "value",
    "",
  );
  // Reopening another tab proves the discarded edit did not acquire a fresh durable identity.
  const reload = await panelServices(harness().client);
  persistReview(reload, { ...shared }, () => {});
  expect(reload.drafts.get().map((draft) => draft.text)).toEqual(["Keep the unrelated finding"]);
  expect(appB.daemon.review.comments()).toEqual([]);
}, 30000);

test("discarding a saved comment removes its retained unsaved edit and leaves another composition intact", async () => {
  const { panel } = await openChanges();
  const block = within(panel).getByRole("region", { name: path });
  await begin(block, "Discard locally", "const b = 4;");
  await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
  await userEvent.click(within(block).getByRole("button", { name: "Edit" }));
  const editing = within(block).getByRole("textbox", { name: "Comment on line 2" });
  await userEvent.clear(editing);
  await userEvent.type(editing, "Retained edit to discard");
  await begin(block, "Keep this other composition", "const b = 5;");
  await userEvent.click(within(block).getByRole("button", { name: "Discard" }));
  expect(
    within(panel).queryByRole("button", { name: /Resume .*Retained edit to discard/ }),
  ).toBeNull();
  expect(within(block).getByRole("textbox", { name: "Comment on line 2" })).toHaveProperty(
    "value",
    "Keep this other composition",
  );
  await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
  expect(within(block).getAllByRole("article")).toHaveLength(1);
  expect(within(block).getByText("Keep this other composition")).toBeTruthy();
}, 30000);

test("repeated empty selections leave only the current editor while preserving a written suggestion", async () => {
  const { panel } = await openChanges();
  const block = within(panel).getByRole("region", { name: path });
  await begin(block, "Keep the written work", "const b = 4;");
  for (let index = 0; index < 40; index++) {
    const line = index % 2 === 0 ? 1 : 3;
    await userEvent.click(within(block).getByRole("button", { name: `Comment on line ${line}` }));
  }
  expect(within(panel).getAllByRole("button", { name: /^Resume / })).toHaveLength(1);
  expect(within(block).getByRole("textbox", { name: "Comment on line 3" })).toHaveProperty(
    "value",
    "",
  );
  await userEvent.click(
    within(panel).getByRole("button", { name: /Resume .*Keep the written work/ }),
  );
  expect(within(panel).queryByRole("button", { name: /^Resume / })).toBeNull();
  expect(within(block).getByRole("textbox", { name: "Comment on line 2" })).toHaveProperty(
    "value",
    "Keep the written work",
  );
  expect(within(block).getByRole("textbox", { name: "Suggested change" })).toHaveProperty(
    "value",
    "const b = 4;",
  );
  await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
  expect(within(block).getByText("Keep the written work")).toBeTruthy();
}, 30000);

test("the composition limit refuses a new selection while keeping written work editable and releases space after save", async () => {
  const { panel } = await openChanges();
  const block = within(panel).getByRole("region", { name: path });
  for (let number = 1; number <= 32; number++) {
    await userEvent.click(within(block).getByRole("button", { name: "Comment on line 2" }));
    await userEvent.type(
      within(block).getByRole("textbox", { name: "Comment on line 2" }),
      `Keep ${number}`,
    );
  }
  await userEvent.click(within(block).getByRole("button", { name: "Comment on line 1" }));
  expect(within(panel).getByRole("alert").textContent).toBe(
    "Save or cancel an unfinished comment before starting another.",
  );
  expect(within(panel).getAllByRole("button", { name: /^Resume / })).toHaveLength(31);
  expect(within(block).getByRole("textbox", { name: "Comment on line 2" })).toHaveProperty(
    "value",
    "Keep 32",
  );
  await userEvent.type(
    within(block).getByRole("textbox", { name: "Comment on line 2" }),
    " edited",
  );
  await userEvent.click(within(panel).getByRole("button", { name: /Resume .*Keep 1$/ }));
  expect(within(block).getByRole("textbox", { name: "Comment on line 2" })).toHaveProperty(
    "value",
    "Keep 1",
  );
  await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
  expect(within(block).getByRole("article").textContent).toContain("Keep 1");
  await userEvent.click(within(block).getByRole("button", { name: "Comment on line 1" }));
  expect(within(block).getByRole("textbox", { name: "Comment on line 1" })).toHaveProperty(
    "value",
    "",
  );
  expect(within(panel).queryByRole("alert")).toBeNull();
  await userEvent.click(within(block).getByRole("button", { name: "Cancel" }));
  await userEvent.click(within(panel).getByRole("button", { name: /Resume .*Keep 32 edited$/ }));
  expect(within(block).getByRole("textbox", { name: "Comment on line 2" })).toHaveProperty(
    "value",
    "Keep 32 edited",
  );
}, 30000);

test("an unfinished deletion suggestion survives abandoning an otherwise blank comment", async () => {
  const { panel } = await openChanges();
  const block = within(panel).getByRole("region", { name: path });
  await userEvent.click(within(block).getByRole("button", { name: "Comment on line 2" }));
  await userEvent.click(within(block).getByRole("button", { name: "Suggest change" }));
  await userEvent.clear(within(block).getByRole("textbox", { name: "Suggested change" }));
  await userEvent.click(within(block).getByRole("button", { name: "Comment on line 1" }));
  await userEvent.click(within(panel).getByRole("button", { name: /Resume .*unfinished comment/ }));
  expect(within(block).getByRole("textbox", { name: "Suggested change" })).toHaveProperty(
    "value",
    "",
  );
  await userEvent.type(
    within(block).getByRole("textbox", { name: "Comment on line 2" }),
    "Remove this line",
  );
  await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
  expect(within(block).getByRole("article").textContent).toContain("Remove this line");
  expect(within(block).getByLabelText("Suggested change").textContent?.trim()).toBe("");
}, 30000);
async function pickScope(panel: HTMLElement, name: string) {
  await userEvent.click(within(panel).getByRole("button", { name: /^Scope:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name: new RegExp(`^${name}`) }));
  return within(panel).findByRole("region", { name: path });
}
async function begin(block: HTMLElement, text: string, replacement: string) {
  await userEvent.click(within(block).getByRole("button", { name: "Comment on line 2" }));
  await userEvent.type(within(block).getByRole("textbox", { name: "Comment on line 2" }), text);
  await userEvent.click(within(block).getByRole("button", { name: "Suggest change" }));
  const suggestion = within(block).getByRole("textbox", { name: "Suggested change" });
  await userEvent.clear(suggestion);
  await userEvent.type(suggestion, replacement);
}
async function readFile(app: ReturnType<typeof harness>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of app.client.downloadFile({ threadId, op: "download", path, offset: 0 }))
    chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

test.each([
  {
    extendTo: 1,
    label: "Comment on lines 1–2",
    lines: ["header", "const b = 2;"],
    result: "const b = 4;\nfooter\n",
  },
  {
    extendTo: 3,
    label: "Comment on lines 2–3",
    lines: ["const b = 2;", "footer"],
    result: "header\nconst b = 4;\n",
  },
])(
  "extending a written suggestion to line $extendTo keeps its content and applies to the extended selection",
  async ({ extendTo, label, lines, result }) => {
    const { app, panel } = await openChanges();
    const block = within(panel).getByRole("region", { name: path });
    await begin(block, "Keep this finding", "const b = 4;");
    await userEvent.keyboard("{Shift>}");
    await userEvent.click(
      within(block).getByRole("button", { name: `Comment on line ${extendTo}` }),
    );
    await userEvent.keyboard("{/Shift}");
    expect(within(block).getByRole("textbox", { name: label })).toHaveProperty(
      "value",
      "Keep this finding",
    );
    expect(within(block).getByRole("textbox", { name: "Suggested change" })).toHaveProperty(
      "value",
      "const b = 4;",
    );
    await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
    await userEvent.click(within(block).getByRole("button", { name: "Apply" }));
    await within(block).findByText("Applied");
    expect(await readFile(app)).toBe(result);
    expect(app.daemon.review.comments()).toEqual([
      expect.objectContaining({
        text: "Keep this finding",
        originalAnchor: expect.objectContaining({
          fingerprint: expect.objectContaining({ lines }),
        }),
      }),
    ]);
  },
  30000,
);

test("changing to a cached diff scope retains its historical suggestion without admitting it against the newer text", async () => {
  const { app, panel } = await openChanges();
  // Warm both scopes so the same annotation position survives the scope transition.
  await pickScope(panel, "Turn 3");
  await pickScope(panel, "Last turn");
  const older = await pickScope(panel, "Turn 3");
  await begin(older, "Change historical a", "const a = 3;");
  const newer = await pickScope(panel, "Last turn");
  expect(within(newer).queryByRole("textbox", { name: "Comment on line 2" })).toBeNull();
  expect(within(newer).queryByRole("textbox", { name: "Suggested change" })).toBeNull();
  const retained = within(panel).getByRole("region", { name: "Unfinished review comment" });
  expect(within(retained).getByRole("textbox", { name: "Suggested change" })).toHaveProperty(
    "value",
    "const a = 3;",
  );
  expect(within(retained).getByRole("button", { name: "Comment" })).toHaveProperty(
    "disabled",
    true,
  );
  await userEvent.click(within(retained).getByRole("textbox", { name: "Comment on line 2" }));
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
  expect(await readFile(app)).toBe(current);
  expect(app.daemon.review.comments()).toEqual([]);

  await begin(newer, "Change current b", "const b = 3;");
  await userEvent.click(within(newer).getByRole("button", { name: "Comment" }));
  const comment = within(newer).getByRole("article", { name: "Comment on line 2" });
  await userEvent.click(within(comment).getByRole("button", { name: "Apply" }));
  await within(newer).findByText("Applied");
  expect(await readFile(app)).toBe("header\nconst b = 3;\nfooter\n");
  expect(app.daemon.review.comments()).toEqual([
    expect.objectContaining({
      resolved: true,
      originalAnchor: expect.objectContaining({
        fingerprint: expect.objectContaining({ lines: ["const b = 2;"] }),
      }),
    }),
  ]);
}, 30000);

test.each(["new comment", "edited saved comment"])(
  "a background edit keeps an unfinished %s and requires reselection before saving its suggestion",
  async (kind) => {
    const { app, panel } = await openChanges();
    const block = within(panel).getByRole("region", { name: path });
    await begin(block, "Original finding", "const b = 4;");
    if (kind === "edited saved comment") {
      await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
      await userEvent.click(within(block).getByRole("button", { name: "Edit" }));
    }
    const text = within(block).getByRole("textbox", { name: "Comment on line 2" });
    await userEvent.clear(text);
    await userEvent.type(text, "Keep my unfinished edits");
    const suggestion = within(block).getByRole("textbox", { name: "Suggested change" });
    await userEvent.clear(suggestion);
    await userEvent.type(suggestion, "const b = 5;");
    const updated = "header\nconst b = 2;\nagent changed the footer\n";
    const stat = await app.client.request({
      type: "files.request",
      threadId,
      operation: { op: "stat", path },
    });
    if (
      stat.type !== "files.result" ||
      typeof stat.value !== "object" ||
      stat.value === null ||
      !("version" in stat.value) ||
      typeof stat.value.version !== "string"
    )
      throw new Error("Missing file version");
    await app.client.request({
      type: "files.request",
      threadId,
      operation: { op: "write", path, expected: stat.value.version, text: updated },
    });
    app.daemon.apply(threadId, edit("background", updated));
    const retained = await within(panel).findByRole("region", {
      name: "Unfinished review comment",
    });
    expect(within(retained).getByRole("textbox", { name: "Comment on line 2" })).toHaveProperty(
      "value",
      "Keep my unfinished edits",
    );
    expect(within(retained).getByRole("textbox", { name: "Suggested change" })).toHaveProperty(
      "value",
      "const b = 5;",
    );
    expect(within(retained).getByRole("button", { name: "Comment" })).toHaveProperty(
      "disabled",
      true,
    );
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(app.daemon.review.comments()).toEqual([]);
    expect(await readFile(app)).toBe(updated);

    // Annotation and tab unmounts must not own the only copy of the unfinished edit.
    await userEvent.click(within(panel).getByRole("tab", { name: "Summary" }));
    await userEvent.click(within(panel).getByRole("tab", { name: /^Changes/ }));
    const older = await pickScope(panel, "Turn 4");
    expect(within(older).queryByRole("textbox", { name: "Comment on line 2" })).toBeNull();
    const recovered = within(panel).getByRole("region", { name: "Unfinished review comment" });
    expect(within(recovered).getByRole("textbox", { name: "Comment on line 2" })).toHaveProperty(
      "value",
      "Keep my unfinished edits",
    );
    expect(within(recovered).getByRole("textbox", { name: "Suggested change" })).toHaveProperty(
      "value",
      "const b = 5;",
    );
    expect(within(recovered).getByRole("button", { name: "Comment" })).toHaveProperty(
      "disabled",
      true,
    );
    await pickScope(panel, "Last turn");
    await userEvent.click(within(panel).getByRole("button", { name: "Reselect lines" }));
    const newer = within(panel).getByRole("region", { name: path });
    await userEvent.click(within(newer).getByRole("button", { name: "Comment on line 2" }));
    expect(within(newer).getByRole("textbox", { name: "Comment on line 2" })).toHaveProperty(
      "value",
      "Keep my unfinished edits",
    );
    await userEvent.click(within(newer).getByRole("button", { name: "Comment" }));
    await userEvent.click(within(newer).getByRole("button", { name: "Apply" }));
    await within(newer).findByText("Applied");
    expect(await readFile(app)).toBe("header\nconst b = 5;\nagent changed the footer\n");
    expect(app.daemon.review.comments()).toEqual([
      expect.objectContaining({
        text: "Keep my unfinished edits",
        suggestion: "const b = 5;",
        originalAnchor: expect.objectContaining({
          fingerprint: expect.objectContaining({
            lines: ["const b = 2;"],
            after: ["agent changed the footer"],
          }),
        }),
      }),
    ]);
  },
  30000,
);

function conversation(block: HTMLElement, text: string) {
  const found = within(block)
    .getAllByRole("article")
    .find((card) => within(card).queryByText(text));
  if (!found) throw new Error(`Missing conversation: ${text}`);
  return found;
}

test("switching between same-line draft editors saves only the selected comment's text and suggestion", async () => {
  const { panel } = await openChanges();
  const block = within(panel).getByRole("region", { name: path });
  await begin(block, "First finding", "const b = 4;");
  await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
  await begin(block, "Second finding", "const b = 5;");
  await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
  await userEvent.click(
    within(conversation(block, "First finding")).getByRole("button", { name: "Edit" }),
  );
  const firstText = within(block).getByRole("textbox", { name: "Comment on line 2" });
  await userEvent.clear(firstText);
  await userEvent.type(firstText, "Unsaved first edit");

  await userEvent.click(within(panel).getByRole("button", { name: "Comments" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /Second finding/ }));
  const dialog = await screen.findByRole("dialog", { name: "Review comment" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Review comment" })).toBeNull());
  const secondText = within(block).getByRole("textbox", { name: "Comment on line 2" });
  const secondSuggestion = within(block).getByRole("textbox", { name: "Suggested change" });
  expect(secondText).toHaveProperty("value", "Second finding");
  expect(secondSuggestion).toHaveProperty("value", "const b = 5;");
  await userEvent.clear(secondText);
  await userEvent.type(secondText, "Second finding revised");
  await userEvent.clear(secondSuggestion);
  await userEvent.type(secondSuggestion, "const b = 6;");
  await userEvent.click(within(block).getByRole("button", { name: "Comment" }));

  expect(within(block).getAllByRole("article")).toHaveLength(2);
  expect(
    within(conversation(block, "First finding")).getByLabelText("Suggested change").textContent,
  ).toBe("const b = 4;");
  expect(
    within(conversation(block, "Second finding revised")).getByLabelText("Suggested change")
      .textContent,
  ).toBe("const b = 6;");
  await userEvent.click(within(panel).getByRole("button", { name: /Resume .*Unsaved first edit/ }));
  expect(within(block).getByRole("textbox", { name: "Comment on line 2" })).toHaveProperty(
    "value",
    "Unsaved first edit",
  );
  expect(within(block).getByRole("textbox", { name: "Suggested change" })).toHaveProperty(
    "value",
    "const b = 4;",
  );
}, 30000);

test("starting a new comment on an edited line clears the earlier editor without changing its draft", async () => {
  const { panel } = await openChanges();
  const block = within(panel).getByRole("region", { name: path });
  await begin(block, "Existing finding", "const b = 4;");
  await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
  await userEvent.click(
    within(conversation(block, "Existing finding")).getByRole("button", { name: "Edit" }),
  );
  await userEvent.click(within(block).getByRole("button", { name: "Comment on line 2" }));
  const fresh = within(block).getByRole("textbox", { name: "Comment on line 2" });
  expect(fresh).toHaveProperty("value", "");
  expect(within(block).queryByRole("textbox", { name: "Suggested change" })).toBeNull();
  await userEvent.type(fresh, "New finding");
  await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
  expect(within(block).getAllByRole("article")).toHaveLength(2);
  expect(
    within(conversation(block, "Existing finding")).getByLabelText("Suggested change").textContent,
  ).toBe("const b = 4;");
  expect(
    within(conversation(block, "New finding")).queryByLabelText("Suggested change"),
  ).toBeNull();
}, 30000);
