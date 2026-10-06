import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import type { ScreenManager } from "@ace/screen";
import type { Interaction, ThreadId } from "@ace/protocol";
import type { startDaemon } from "../index.ts";
import { BrowserClient } from "../browser-test-client.ts";

/** A real host command answers the session escalation; no injected approval bypass. */
export async function approveForeground(
  daemon: Awaited<ReturnType<typeof startDaemon>>,
  screen: ScreenManager,
  sessionId: string,
  threadId: ThreadId,
) {
  const client = new BrowserClient(daemon.url);
  const lifetime = new AbortController();
  const opened = Promise.withResolvers<Interaction>();
  const unwatch = daemon.store.subscribe((events) => {
    for (const event of events)
      if (
        event.payload.type === "interaction.opened" &&
        event.payload.interaction.threadId === threadId &&
        event.payload.interaction.request?.kind === "approval" &&
        event.payload.interaction.request.target?.tool === "screen_request_foreground"
      )
        opened.resolve(event.payload.interaction);
  });
  try {
    await client.hello((await readFile(daemon.tokenPath, "utf8")).trim());
    const escalation = screen.mode(sessionId, "foreground", lifetime.signal);
    void escalation.catch(opened.reject);
    const interaction = await opened.promise;
    expect(screen.state(sessionId).mode).toBe("background");
    const commandId = `foreground-${interaction.id}`;
    client.send({
      type: "command",
      command: {
        id: commandId,
        deviceId: "device",
        payload: {
          type: "interaction.resolve",
          interactionId: interaction.id,
          resolution: { kind: "approval", optionId: "allow_once" },
        },
      },
    });
    expect(
      await client.next(
        (message) => message.type === "commandResult" && message.commandId === commandId,
      ),
    ).toMatchObject({ ok: true });
    expect((await escalation).mode).toBe("foreground");
  } finally {
    lifetime.abort();
    unwatch();
    await client.close();
  }
}
