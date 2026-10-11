import { coldStartReplay, facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

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
async function openChanges() {
  const app = harness();
  app.play(coldStartReplay()).runThrough("test-done");
  app.daemon.apply(threadId, edit("historical", historical));
  app.daemon.apply(threadId, edit("current", current));
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await screen.findByRole("button", { name: "Right panel" }, { timeout: 10000 });
  await app.client.request({
    type: "files.request",
    threadId,
    operation: { op: "create", path, expected: null, text: current },
  });
  await userEvent.keyboard("{Meta>}{Shift>}d{/Shift}{/Meta}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("region", { name: path });
  return { app, panel };
}
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
  { extendTo: 1, label: "Comment on lines 1–2", lines: ["header", "const b = 2;"], result: "const b = 4;\nfooter\n" },
  { extendTo: 3, label: "Comment on lines 2–3", lines: ["const b = 2;", "footer"], result: "header\nconst b = 4;\n" },
])("extending a written suggestion to line $extendTo keeps its content and applies to the extended selection", async ({ extendTo, label, lines, result }) => {
  const { app, panel } = await openChanges();
  const block = within(panel).getByRole("region", { name: path });
  await begin(block, "Keep this finding", "const b = 4;");
  await userEvent.keyboard("{Shift>}");
  await userEvent.click(within(block).getByRole("button", { name: `Comment on line ${extendTo}` }));
  await userEvent.keyboard("{/Shift}");
  expect(within(block).getByRole("textbox", { name: label })).toHaveProperty("value", "Keep this finding");
  expect(within(block).getByRole("textbox", { name: "Suggested change" })).toHaveProperty("value", "const b = 4;");
  await userEvent.click(within(block).getByRole("button", { name: "Comment" }));
  await userEvent.click(within(block).getByRole("button", { name: "Apply" }));
  await within(block).findByText("Applied");
  expect(await readFile(app)).toBe(result);
  expect(app.daemon.review.comments()).toEqual([
    expect.objectContaining({ text: "Keep this finding", originalAnchor: expect.objectContaining({ fingerprint: expect.objectContaining({ lines }) }) }),
  ]);
}, 30000);

test("changing to a cached diff scope cancels its historical suggestion and a fresh suggestion applies only the newly selected text", async () => {
  const { app, panel } = await openChanges();
  // Warm both scopes so the same annotation position survives the scope transition.
  await pickScope(panel, "Turn 3");
  await pickScope(panel, "Last turn");
  const older = await pickScope(panel, "Turn 3");
  await begin(older, "Change historical a", "const a = 3;");
  const newer = await pickScope(panel, "Last turn");
  expect(within(newer).queryByRole("textbox", { name: "Comment on line 2" })).toBeNull();
  expect(within(newer).queryByRole("textbox", { name: "Suggested change" })).toBeNull();
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
