import { CommandId, DeviceId, ThreadId, WorkspaceId } from "@ace/protocol";
import { configure, screen, within } from "@testing-library/react";
import { test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { pressEndUntil } from "@/test/list-end.ts";
import { useScrollLayout } from "@/test/scroll-layout.ts";

configure({ asyncUtilTimeout: 20000 });
useScrollLayout({ viewport: 600, row: 40 });

const minute = 60_000;
const pad = (n: number) => String(n).padStart(4, "0");

test("Chats keep paging older settled chats in as the list's end scrolls into view", async () => {
  const app = harness();
  for (let n = 1; n <= 150; n++) {
    const id = `thread-old-chat-${pad(n)}`;
    const workspace = `chat-old-${pad(n)}`;
    app.daemon.createThread(
      {
        id,
        workspaceId: WorkspaceId.parse(workspace),
        title: `Old chat ${pad(n)}`,
        provider: "claude",
        hasSentMessage: true,
        details: {
          workspace: {
            id: workspace,
            name: "Chat",
            path: `/fake/chats/${workspace}`,
            kind: "chat",
          },
          mode: "local",
        },
      },
      n * minute,
    );
    app.daemon.command({
      id: CommandId.parse(`settle-${id}`),
      deviceId: DeviceId.parse("long-lists"),
      payload: { type: "thread.settle", threadId: ThreadId.parse(id) },
    });
  }
  await app.open("/chats");
  const nav = within(await screen.findByRole("navigation", { name: "Chats" }));
  const list = await nav.findByRole("list", { name: "Chats" });
  const first = await within(list).findAllByRole("link", { name: /^Old chat \d+/ });
  const top = Number(/(\d+)/.exec(first[0]?.getAttribute("aria-label") ?? "")?.[1]);
  // The daemon sends 20 settled threads a page: past 100 from the top is five pages in.
  await pressEndUntil(list, /^Old chat (\d+)/, (n) => Math.abs(n - top) >= 100);
}, 40_000);
