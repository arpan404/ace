import { Client } from "@ace/client";
import { FakeDaemon, fakeTransport } from "@ace/fake-daemon";
import { DeviceId, type Automation, type AutomationRun, type ThreadStatus } from "@ace/protocol";
import { readAgents } from "./agent-read.ts";
import { ModelFavorites } from "./model-favorites.ts";
import { NativeAutomations, type NativeAutomationRequest } from "./automations.ts";

/*
 * The phone's Automations bridge over the real SDK and an in-process fake daemon, for the
 * automations tests. No provider CLI runs. Test-only.
 */

// Tuesday 27 October 2026, noon in London (GMT after the clocks went back).
export const now = Date.UTC(2026, 9, 27, 12, 0);
export const zone = "Europe/London";
let close: (() => Promise<void>) | undefined;
/** Closes the last fixture's client; each test file calls it after every test. */
export async function closeFixture() {
  await close?.();
  close = undefined;
}

export interface Options {
  /** Whether the machine runs automations. */
  running?: boolean;
  /** Each automation.put whose reply never reaches the phone (by 1-based put number). */
  lostPuts?: number[];
  /** The project's GitHub repository, as its remotes say. */
  repository?: string;
  /** More of the machine's settings, such as its webhook ways in. */
  settings?: Record<string, unknown>;
}

export async function fixture(
  seed: { automations?: Automation[]; runs?: AutomationRun[] } = {},
  states: Record<string, ThreadStatus["state"]> = {},
  options: Options = {},
) {
  const daemon = new FakeDaemon({ clock: () => now });
  daemon.seedServices({
    settings: { "automations.enabled": options.running ?? true, ...options.settings },
    ...seed,
  });
  let sequence = 0;
  const client = new Client({
    deviceId: DeviceId.parse("phone"),
    transport: () => fakeTransport(daemon),
    storage: { load: async () => null, save: async () => {} },
    credential: async () => daemon.token,
    scheduler: { set: () => () => {} },
    random: () => 0,
    id: () => `read-${++sequence}`,
  });
  const ready = new Promise<void>((resolve) => {
    const stop = client.connectionState().subscribe(() => {
      if (client.state === "ready") {
        stop();
        resolve();
      }
    });
  });
  await client.start();
  await ready;
  close = () => client.close();
  const favorites = new ModelFavorites(client);
  let puts = 0;
  // The daemon gets every put; a lost one's reply never reaches the phone.
  const owner: Pick<Client, "request"> = {
    request: (async (request: Parameters<Client["request"]>[0], requestOptions?: object) => {
      const reply = await client.request(request, requestOptions);
      if (request.type === "automation.put" && options.lostPuts?.includes(++puts))
        throw new Error("The connection dropped before the reply arrived.");
      return reply;
    }) as Client["request"],
  };
  const automations = new NativeAutomations({
    owner,
    repository: async () => options.repository,
    now: () => now,
    zone: () => zone,
    agents: async () => (await readAgents(client, favorites, now)).agents,
    threadState: (threadId) => states[threadId],
  });
  const ask = (request: NativeAutomationRequest) =>
    automations.answer(request, new AbortController().signal);
  return { daemon, client, ask };
}

export const base: Automation = {
  id: "nightly",
  title: "Nightly dependency check",
  enabled: true,
  workspace: "/Users/me/ace-next",
  provider: "claude",
  prompt: "Check for outdated dependencies",
  worktree: true,
  trigger: {
    kind: "schedule",
    schedule: {
      kind: "rrule",
      expression: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      timezone: zone,
      startAt: Date.UTC(2026, 9, 1, 8, 0),
    },
  },
  missedRun: "run_once",
  concurrency: 1,
  jitterMs: 0,
};
