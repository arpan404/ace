import { facts } from "@ace/fake-daemon";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const original = Element.prototype.scrollIntoView;
afterEach(() => {
  Element.prototype.scrollIntoView = original;
});

async function answer(text: string) {
  const app = harness();
  app.daemon.createThread({ id: "files", workspaceId: "ace", title: "Files", provider: "codex" });
  app.daemon.apply("files", [
    facts.rootAgent("codex"),
    facts.message("root", "answer", "assistant", text),
  ]);
  await app.open("/t/files");
  return screen.findByRole("feed", { name: "Transcript" });
}

test("a bare filename in an answer opens its one checkout file in Files at the line", async () => {
  const revealed: string[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    const line = this.getAttribute("data-line");
    if (line !== null) revealed.push(line);
  };
  const feed = await answer("The reconnect lives in `socket.ts:3`.");
  const link = await within(feed).findByRole("link", { name: "socket.ts:3" });
  link.focus();
  await userEvent.keyboard("{Enter}");

  const side = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(side).findByRole("tab", { name: "socket.ts", selected: true })).toBeTruthy();
  const source = await within(side).findByRole("region", {
    name: "Source of apps/web/src/relay/socket.ts",
  });
  await waitFor(() => expect(source.textContent).toContain("export class RelaySocket {"));
  // Line 3 (1-based) is brought into view.
  await waitFor(() => expect(revealed).toContain("2"));
}, 30_000);

test("a path in running text links too, while unknown and shared names stay plain", async () => {
  const feed = await answer(
    "Changed apps/web/src/relay/outbox.ts and `missing.ts`; `resume.ts` exists twice.",
  );
  expect(
    await within(feed).findByRole("link", { name: "apps/web/src/relay/outbox.ts" }),
  ).toBeTruthy();
  // An unknown file is plain code, never a link.
  await waitFor(() => expect(within(feed).getByText("missing.ts").tagName).toBe("CODE"));
  expect(within(feed).queryByRole("link", { name: "missing.ts" })).toBeNull();

  // A name two files share opens the Files tree filtered to it instead of guessing one.
  await userEvent.click(await within(feed).findByRole("link", { name: "resume.ts" }));
  const side = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(side).findByRole("tab", { name: "Files", selected: true })).toBeTruthy();
  const find = await within(side).findByRole<HTMLInputElement>("searchbox", {
    name: "Find files in the checkout",
  });
  expect(find.value).toBe("resume.ts");
}, 30_000);
