import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, vi } from "vitest";
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
import { MachineFailure, machineRequest, type MachineTransport } from "./transport.ts";

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
  options: {
    scopes?: DeviceScope[];
    access?: MachineAgentAccess;
    /** The target's engine limits, e.g. one active thread so its engine is full. */
    targetEngineLimits?: Partial<import("../engine/limits.ts").EngineLimits>;
    /** The source's calls to the target, e.g. the real transport wrapped to hold a reply. */
    sourceTransport?: import("./transport.ts").MachineTransport;
    /** The target's computer use: its switch and the engine its agents drive. */
    targetScreen?: {
      screen: import("@ace/screen").ScreenManager;
      computer: import("@ace/screen").ComputerClient;
    };
  } = {},
) {
  const target = await daemonFixture(
    undefined,
    {
      browser: browser(),
      machines: { pollMs: 50 },
      ...(options.targetEngineLimits ? { engineLimits: options.targetEngineLimits } : {}),
      ...options.targetScreen,
    },
    { ACE_LISTEN: "lan", ACE_ADVERTISE_HOST: "127.0.0.1" },
  );
  cleanup.push(() => target.daemon.close());
  const source = await daemonFixture(undefined, {
    browser: browser(),
    machines: {
      pollMs: 50,
      ...(options.sourceTransport ? { transport: options.sourceTransport } : {}),
    },
  });
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
  const profile = (url: string, print: string) => ({
    name: "studio",
    origin: `${url.replace("wss:", "https:").replace(/\/?$/, "/")}`,
    fingerprint: print,
    deviceId: credential.device.id,
    token: credential.token,
  });
  const profiles = new Profiles(join(source.h.home, "daemon"));
  profiles.add(profile(remoteUrl, fingerprint));
  profiles.close();
  /**
   * Restarts the target daemon on the same data. It listens on a new port, so the source's
   * saved machine is pointed there, as relinking a machine does; the pairing itself is kept.
   */
  async function restartTarget(stopped?: (dataDir: string) => void | Promise<void>) {
    target.daemon = await target.restart(stopped);
    const { remoteUrl: url, fingerprint: print } = target.daemon;
    if (!url || !print) throw new Error("Target is not listening after its restart");
    const saved = new Profiles(join(source.h.home, "daemon"));
    try {
      saved.replace("studio", profile(url, print));
    } finally {
      saved.close();
    }
  }
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
  /**
   * Finishes a target thread's turn once `input` reached its provider, so the turn ended is the
   * one running that input, not a session still opening; then waits for the thread to be done.
   */
  async function finishTask(threadId: ThreadId, input: string, text: string) {
    await vi.waitFor(
      () => expect((target.h.inputs.get(threadId) ?? []).join("\n")).toContain(input),
      { timeout: 15_000 },
    );
    await finish(threadId, text);
    await vi.waitFor(
      () => expect(target.daemon.store.getThread(threadId)?.status.state).toBe("done"),
      { timeout: 15_000 },
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
  /** Restarts the source daemon on the same data, as the machine calling the target. */
  async function restartSource() {
    source.daemon = await source.restart();
  }
  return {
    restartSource,
    source,
    target,
    credential,
    access,
    emit,
    finish,
    finishTask,
    requestIn,
    answer,
    restartTarget,
  };
}

/**
 * The source's calls to the target, where message requests can be held before they reach it, as
 * a request waiting in the target's access check is from the caller's side. `failCaller` makes
 * the caller hear a dropped connection while its request is still on its way.
 */
export function gatedTransport() {
  const gate = { closed: false, failCaller: false, onlyFirst: false, release: () => {} };
  let opened = Promise.resolve();
  let arrived: Promise<void> = Promise.resolve();
  let held = 0;
  let statusCalls = 0;
  const transport: MachineTransport = async (profile, body, options) => {
    if (body.call.op === "status") statusCalls++;
    if (body.call.op !== "message" || !gate.closed || (gate.onlyFirst && held > 0))
      return machineRequest(profile, body, options);
    held++;
    const arrives = opened.then(() => machineRequest(profile, body, options));
    arrived = arrives.then(
      () => undefined,
      () => undefined,
    );
    if (!gate.failCaller) return arrives;
    arrives.catch(() => undefined);
    throw new MachineFailure("disconnected");
  };
  return {
    transport,
    gate,
    held: () => held,
    /** Settles once the held copies have reached the target and it answered. */
    arrived: () => arrived,
    statusCalls: () => statusCalls,
    close() {
      gate.closed = true;
      opened = new Promise((resolve) => {
        gate.release = () => resolve();
      });
    },
    open() {
      gate.closed = false;
      gate.release();
    },
  };
}
