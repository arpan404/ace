import { coldStartReplay } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

/*
 * Save meets a change on disk and asks before replacing it (spec 46). The answer covers the
 * version it asked about: a write that lands while the question is open is never overwritten
 * by it, and is asked about in turn.
 */

const threadId = ThreadId.parse("thread-cold-start");
const path = "apps/web/src/relay/socket.ts";

async function read(app: ReturnType<typeof harness>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of app.client.downloadFile({ threadId, op: "download", path, offset: 0 }))
    chunks.push(chunk);
  return new TextDecoder().decode(
    await new Blob(chunks.map((chunk) => new Uint8Array(chunk))).arrayBuffer(),
  );
}

async function version(app: ReturnType<typeof harness>) {
  const stat = await app.client.request({
    type: "files.request",
    threadId,
    operation: { op: "stat", path },
  });
  const value = stat.type === "files.result" ? stat.value : undefined;
  if (typeof value !== "object" || value === null || !("version" in value))
    throw new Error("Missing the file's version");
  return String(value.version);
}

async function writeBehind(app: ReturnType<typeof harness>, text: string) {
  await app.client.request({
    type: "files.request",
    threadId,
    operation: { op: "write", path, expected: await version(app), text },
  });
}

test("a Replace answered for one version never overwrites a write that landed while it was asked", async () => {
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.keyboard("{Control>}p{/Control}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search files" }), "socket");
  await userEvent.keyboard("{Enter}");
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await userEvent.click(await within(panel).findByRole("textbox", { name: "socket.ts" }));
  await userEvent.keyboard("{Control>}a{/Control}mine");

  await writeBehind(app, "version B");
  await userEvent.keyboard("{Control>}s{/Control}");
  const first = await screen.findByRole("dialog", {
    name: "socket.ts changed on disk. Replace it?",
  });
  // While the person reads the question about B, C lands.
  await writeBehind(app, "version C");
  await userEvent.click(within(first).getByRole("button", { name: "Replace" }));

  // Nothing was written over C: the question comes back, about C.
  const again = await screen.findByRole("dialog", {
    name: "socket.ts changed on disk. Replace it?",
  });
  expect(await read(app)).toBe("version C");
  await userEvent.click(within(again).getByRole("button", { name: "Replace" }));
  await waitFor(async () => expect(await read(app)).toBe("mine"));
});
