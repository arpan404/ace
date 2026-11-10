import "./test-host.ts";
import { seedForgeBrowse } from "@ace/fake-daemon";
import type { CommandPayload, ThreadListEntry } from "@ace/protocol";
import { downloadFile } from "@ace/client/files";
import { afterEach } from "vitest";
import type { ForgeOwner } from "./forge-reads.ts";
import { ForgeRequest, ForgeService } from "./forge-service.ts";
import { plainPreview, sheetFixture, until } from "./sheet-fixture.ts";

/*
 * The fake daemon's forge, read by a phone runtime's forge service: what the forge tests ask,
 * every command it sent, and every read it made.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

export const repository = {
  forge: "github",
  host: "github.com",
  owner: "acme",
  name: "ace",
} as const;

/** The fake daemon's `ace` repository on GitHub, read by a phone runtime. */
export async function connected(
  threads?: ThreadListEntry[],
  stamp: () => string = () => "",
  command?: ForgeOwner["command"],
) {
  const { daemon, client } = sheetFixture();
  seedForgeBrowse(daemon, Date.parse("2026-10-20T00:00:00Z"));
  // The daemon serves forge media to a registered project; a thread there registers `ace`.
  daemon.createThread({
    id: "forge-project",
    workspaceId: "ace",
    title: "Project",
    provider: "codex",
    hasSentMessage: true,
  });
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const sent: CommandPayload[] = [];
  const reads: unknown[] = [];
  const owner: ForgeOwner = {
    request: (request, options) => {
      reads.push(request);
      return client.request(request, options);
    },
    command: (payload) => {
      sent.push(payload);
      return command ? command(payload) : client.command(payload);
    },
    threads: threads
      ? () =>
          ({
            store: {
              ids: threads.map((thread) => thread.id),
              thread: (id: string) => threads.find((thread) => thread.id === id),
            },
            release() {},
          }) as unknown as ReturnType<ForgeOwner["threads"]>
      : () => client.threads(),
  };
  let ids = 0;
  const forge = new ForgeService(
    owner,
    plainPreview,
    () => 0,
    stamp,
    () => `draft-${++ids}`,
    (input, signal) => downloadFile(client, input, { signal, timeoutMs: 15_000 }),
  );
  const ask = (request: Record<string, unknown>) =>
    // Parsed as the native service parses it, defaults included.
    forge.answer(ForgeRequest.parse(request), new AbortController().signal);
  return { daemon, client, sent, reads, ask };
}
