import { coldStartReplay, facts } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, within } from "@testing-library/react";
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
