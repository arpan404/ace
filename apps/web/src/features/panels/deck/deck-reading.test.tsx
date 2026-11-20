import { coldStartReplay } from "@ace/fake-daemon";
import { configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "../files/folders-test-support.ts";

/*
 * Reading code in the Deck: a selected range goes to the chat as a mention, and a file the
 * pointer rests on in the explorer is read ahead, so opening it doesn't wait on another read.
 */

configure({ asyncUtilTimeout: 10000 });

async function openThread() {
  const app = harness();
  folderFixture(app.client, "thread-cold-start");
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  return app;
}

const panel = () => screen.findByRole("region", { name: "Thread panel" });

async function open(text: string) {
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), text);
  await screen.findByRole("option", { name: new RegExp(text) });
  await userEvent.keyboard("{Enter}");
  return panel();
}

/** Folders start folded: open each of `folders` in `tree` so a nested file shows. */
async function reveal(tree: HTMLElement, folders: readonly string[]) {
  for (const folder of folders) {
    const row = await waitFor(() => {
      const found = tree.querySelector<HTMLElement>(`[data-path="${folder}"]`);
      if (!found) throw new Error(`${folder} is not listed yet`);
      return found;
    });
    if (row.getAttribute("aria-expanded") !== "true") await userEvent.click(row);
  }
}

/** Paths the app asked the daemon to read, in order, from the wire. */
function readsOf(app: ReturnType<typeof harness>): string[] {
  const reads: string[] = [];
  const request = app.client.request.bind(app.client);
  app.client.request = ((message: Parameters<typeof request>[0], options) => {
    const operation = message.type === "files.request" ? message.operation : undefined;
    if (operation && operation.op === "read") reads.push(operation.path);
    return request(message, options);
  }) as typeof request;
  return reads;
}

test("a range selected in a Deck editor is mentioned in the chat and sends only those lines", async () => {
  const app = await openThread();
  const sent: unknown[] = [];
  const receive = app.daemon.command.bind(app.daemon);
  app.daemon.command = (command) => {
    if (command.payload.type === "thread.send") sent.push(command.payload.context?.mentions);
    return receive(command);
  };
  const side = await open("socket");
  const source = await within(side).findByRole("region", {
    name: "Source of apps/web/src/relay/socket.ts",
  });
  await waitFor(() => expect(source.textContent).toContain("export class RelaySocket"));
  // Select the visible source words exactly as a mouse drag does.
  const walk = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  const words: Text[] = [];
  while (walk.nextNode()) if (walk.currentNode instanceof Text) words.push(walk.currentNode);
  const first = words.find((node) => node.textContent?.includes("import"));
  const last = words.find((node) => node.textContent?.includes("RelaySocket"));
  if (!first || !last) throw new Error("Source words are missing");
  const range = document.createRange();
  range.setStart(first, 0);
  range.setEnd(last, last.length);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  fireEvent.mouseUp(source);
  const action = await within(side).findByRole("button", { name: /Mention selection · lines 1–/ });
  const end = Number(action.textContent?.split("–").at(-1));
  await userEvent.click(action);
  const message = screen.getByRole("combobox", { name: "Message" });
  expect(message.textContent).toContain(`@apps/web/src/relay/socket.ts:1-${end}`);
  await userEvent.type(message, "Explain this{Enter}");
  await waitFor(() =>
    expect(sent.at(-1)).toEqual([
      { path: "apps/web/src/relay/socket.ts", lines: { start: 1, end } },
    ]),
  );
});

test("a file the pointer rests on in the explorer opens without being read again", async () => {
  const app = await openThread();
  const side = await open("replay.ts");
  await within(side).findByRole("region", { name: /^Source of .*replay\.ts$/ });
  const tree = within(side).getByRole("tree", { name: "Checkout files" });
  // outbox.ts lives in another subtree, folded by default: reveal it first.
  await reveal(tree, ["apps/web/", "apps/web/src/", "apps/web/src/relay/"]);
  const reads = readsOf(app);
  const row = within(tree).getByRole("treeitem", { name: "outbox.ts" });
  await userEvent.hover(row);
  await waitFor(() => expect(reads).toContain("apps/web/src/relay/outbox.ts"));
  const before = reads.length;
  await userEvent.click(row);
  const source = await within(side).findByRole("region", {
    name: "Source of apps/web/src/relay/outbox.ts",
  });
  await waitFor(() => expect(source.textContent).toContain("buffer"));
  expect(reads.slice(before)).not.toContain("apps/web/src/relay/outbox.ts");
});
