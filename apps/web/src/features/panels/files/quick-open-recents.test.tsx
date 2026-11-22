import { coldStartReplay } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { z } from "zod";
import { harness } from "@/test/harness.tsx";
import { folderFixture } from "./folders-test-support.ts";

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

/** ⌘P, type `text`, Enter on the first match once it is listed. */
async function pick(text: string) {
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), text);
  await screen.findByRole("option", { name: new RegExp(text.replace(".", "\\.")) });
  await userEvent.keyboard("{Enter}");
  await within(await panel()).findByRole("tab", { name: text, selected: true });
}

test("quick open's empty list leads with open editors, then files agents changed, then recent files", async () => {
  await openThread();
  await pick("README.md");
  await pick("socket.ts");
  await pick("outbox.ts");
  // README.md is closed again: it stays a recent file, no longer an open one.
  const side = await panel();
  await userEvent.click(within(side).getByRole("tab", { name: "README.md" }));
  await userEvent.keyboard("{Alt>}{Control>}w{/Control}{/Alt}");
  await waitFor(() => expect(within(side).queryByRole("tab", { name: "README.md" })).toBeNull());
  await userEvent.click(within(side).getByRole("tab", { name: "outbox.ts" }));

  await userEvent.keyboard("{Control>}p{/Control}");
  const list = await screen.findByRole("listbox", { name: "Files" });
  const names = within(list)
    .getAllByRole("option")
    .map((option) => option.querySelector("span")?.textContent);
  // Open editors, the showing one first: outbox.ts, then socket.ts. Then the thread's edits
  // not already listed (replay.ts), then what was opened before (README.md). No narration.
  expect(names).toEqual(["outbox.ts", "socket.ts", "replay.ts", "README.md"]);
  expect(within(list).getByText("Open editors")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

test("after quick open opens a file, the keyboard is in the file, not back in the composer", async () => {
  await openThread();
  (await screen.findByLabelText("Message")).focus();
  await pick("socket.ts");
  const source = await within(await panel()).findByRole("region", {
    name: "Source of apps/web/src/relay/socket.ts",
  });
  await waitFor(() => expect(source.contains(document.activeElement)).toBe(true));
});

/** Answer the checkout's path search as "still building the index" until the returned call. */
function buildingIndex(client: unknown) {
  const Completion = z.object({
    type: z.literal("context.request"),
    operation: z.object({ op: z.literal("mention.complete") }),
  });
  const patched = client as { request(input: unknown, options?: unknown): Promise<unknown> };
  const request = patched.request.bind(patched);
  let building = true;
  patched.request = async (input, options) => {
    const reply = await request(input, options);
    if (!building || !Completion.safeParse(input).success) return reply;
    const Reply = z.looseObject({ result: z.looseObject({ kind: z.literal("completion") }) });
    const parsed = Reply.safeParse(reply);
    if (!parsed.success) return reply;
    return { ...parsed.data, result: { ...parsed.data.result, paths: [], ready: false } };
  };
  return () => {
    building = false;
  };
}

test("while the checkout's index builds, quick open lists the open and recent files that match", async () => {
  const app = await openThread();
  await pick("socket.ts");
  await pick("README.md");
  // README.md is closed again: a recent file now, no longer an open one.
  const side = await panel();
  await userEvent.click(within(side).getByRole("tab", { name: "README.md" }));
  await userEvent.keyboard("{Alt>}{Control>}w{/Alt}{/Control}");
  await waitFor(() => expect(within(side).queryByRole("tab", { name: "README.md" })).toBeNull());

  const built = buildingIndex(app.client);
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), "e");
  const list = await screen.findByRole("listbox", { name: "Files" });
  const names = () =>
    within(list)
      .queryAllByRole("option")
      .map((option) => option.querySelector("span")?.textContent);
  // Both hold an "e", so both show at once; events.ts waits for the index.
  await waitFor(() => expect(names()).toEqual(expect.arrayContaining(["socket.ts", "README.md"])));
  expect(names()).not.toContain("events.ts");
  expect(screen.getByRole("status", { name: "Searching" })).toBeTruthy();
  // Once the index is built, the rest of the checkout's matches join them, each file once.
  built();
  await waitFor(() => expect(names()).toContain("events.ts"));
  const paths = within(list)
    .getAllByRole("option")
    .map((option) => option.textContent);
  expect(new Set(paths).size).toBe(paths.length);
});
