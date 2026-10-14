import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, vi } from "vitest";
import { FakeHeadless } from "@ace/browser/testing";
import {
  Command,
  PairingResponse,
  type DeviceScope,
  type Interaction,
  type MachineAgentAccess,
  type ThreadId,
} from "@ace/protocol";
import type { Fact } from "@ace/core";
import { daemonFixture } from "../agent-control/daemon-test-support.ts";
import { accessRequest, redeemPairing } from "../client-access.ts";
import { Profiles } from "../cli/profiles.ts";
import { commandContext } from "../commands.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
}, 60_000);

const browser = () => ({ headlessBackend: new FakeHeadless(), ffmpeg: "/nonexistent/ffmpeg" });

/**
 * Two real daemons in their own temp homes. The target listens for paired devices over TLS;
 * the source pairs with it the way `ace remote add` stores a machine, as profile `studio`.
 */
export async function pairedMachines(
  options: { scopes?: DeviceScope[]; access?: MachineAgentAccess } = {},
) {
  const target = await daemonFixture(
    undefined,
    { browser: browser(), machines: { pollMs: 50 } },
    { ACE_LISTEN: "lan", ACE_ADVERTISE_HOST: "127.0.0.1" },
  );
  cleanup.push(() => target.daemon.close());
  const source = await daemonFixture(undefined, { browser: browser(), machines: { pollMs: 50 } });
  cleanup.push(() => source.daemon.close());
  const { remoteUrl, fingerprint } = target.daemon;
  if (!remoteUrl || !fingerprint) throw new Error("Target is not listening for paired devices");
  const targetHome = join(target.h.home, "daemon");
  const pairing = PairingResponse.parse(
    await accessRequest(readFileSync(join(targetHome, "daemon-endpoint"), "utf8"), "/v1/pairings", {
      method: "POST",
      token: readFileSync(target.daemon.tokenPath, "utf8"),
      body: { scopes: options.scopes ?? ["read", "operate"] },
    }),
  );
  const credential = await redeemPairing(pairing.url, "MacBook");
  const profiles = new Profiles(join(source.h.home, "daemon"));
  profiles.add({
    name: "studio",
    origin: `${remoteUrl.replace("wss:", "https:").replace(/\/?$/, "/")}`,
    fingerprint,
    deviceId: credential.device.id,
    token: credential.token,
  });
  profiles.close();
  await target.daemon.settings.set("host.displayName", "Studio", { kind: "global" });
  const access = (value: MachineAgentAccess) =>
    target.daemon.settings.set("remote.agentAccess", value, { kind: "global" });
  if (options.access) await access(options.access);

  /** Plays provider output into a thread the target runs. */
  async function emit(threadId: ThreadId, ...facts: Fact[]) {
    await vi.waitFor(() => {
      if (!target.h.contexts.get(threadId)) throw new Error("Session not open yet");
    });
    target.h.contexts.get(threadId)?.onFrame(target.h.frames.frame(...facts));
    await target.daemon.engine?.flush();
  }
  async function finish(threadId: ThreadId, text: string) {
    await emit(
      threadId,
      {
        type: "item.upsert",
        agent: "root",
        item: randomUUID(),
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text }],
          complete: true,
        },
      },
      { type: "turn.ended", agent: "root", outcome: "completed" },
    );
  }
  /** Resolves when a request opens in the given daemon's thread. */
  function requestIn(
    side: typeof source,
    threadId: ThreadId,
    match: (interaction: Interaction) => boolean,
  ): Promise<Interaction> {
    return new Promise((resolve) => {
      const stop = side.daemon.store.subscribe((events) => {
        for (const event of events)
          if (
            event.payload.type === "interaction.opened" &&
            event.threadId === threadId &&
            match(event.payload.interaction)
          ) {
            stop();
            resolve(event.payload.interaction);
          }
      });
    });
  }
  /** The person answers in a thread on the source, as the composer strip does. */
  function answer(interaction: Interaction, optionId: string) {
    const engine = source.daemon.engine;
    if (!engine) throw new Error("Engine unavailable");
    const command = Command.parse({
      id: `answer-${randomUUID()}`,
      deviceId: "person",
      payload: {
        type: "interaction.resolve",
        interactionId: interaction.id,
        resolution: { kind: "approval", optionId },
      },
    });
    return source.daemon.store.recordCommand(command.id, command.deviceId, () =>
      engine.handler.handle(command, commandContext(source.daemon.store)),
    );
  }
  return { source, target, credential, access, emit, finish, requestIn, answer };
}
