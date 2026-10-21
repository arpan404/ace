import { host } from "./polyfills.ts";
import { ClientCore, type Lease, type ThreadSource } from "@ace/client";
import { z } from "zod";
import { DeviceId, HostId } from "@ace/protocol";
import { call, scheduler } from "./host.ts";
import { PatchPump, followThread } from "./patches.ts";
import { followInbox, inboxAction, makeActivityGeneration } from "./inbox.ts";
import { ArchiveBrowser } from "./archive.ts";
import { dispatchCommand } from "./commands.ts";
import { ThreadSession } from "./thread-session.ts";
import { routeThreadAction } from "./thread-route.ts";
import { connectionProblem, pairedCredential, TrustMonitor } from "./access.ts";
import { aceAccess, nativeHttp } from "./access-entry.ts";
import { nativeTransport, socketEvent } from "./socket.ts";
import { followMachine, MachineProviders } from "./machine-info.ts";
import { NotificationAction, NotificationBridge } from "./notifications.ts";
import { Sheets } from "./sheets.ts";
import { preview } from "./presentation.ts";
import { ComposeActions } from "./compose-actions.ts";
import { NativeServices, NativeServiceAction } from "./native-services.ts";
import { NativeTerminal, NativeTerminalAction } from "./native-terminal.ts";
import { BrowserLive } from "./browser-live.ts";
import { nativeChunks } from "./thread-attachments.ts";
import { agentName } from "@ace/ui-core";
import { NativeDevices, NativeDeviceControl } from "./native-devices.ts";
import { NativeScreen, NativeScreenControl } from "./native-screen.ts";

const Config = z.object({
  deviceId: DeviceId,
  hostId: HostId,
  itemLimit: z.number().int().min(200).max(2200),
  /** A paired machine: each socket attempt exchanges the Keychain token for a fresh ticket. */
  paired: z.strictObject({ secretKey: z.string().min(1).max(1024) }).optional(),
});
const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open"), threadId: z.string().min(1) }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("network"), online: z.boolean() }),
  z.object({
    type: z.literal("command"),
    payload: z.unknown(),
    requestId: z.string().min(1).max(64),
  }),
  z.object({ type: z.literal("retry") }),
  z.object({ type: z.literal("machine.refresh") }),
  /** `epoch`: the navigation generation the action was sent for (`thread-route.ts`). */
  z.object({
    type: z.literal("thread"),
    action: z.unknown(),
    epoch: z.number().int().nonnegative().optional(),
  }),
  /** The thread's Agents and Changes sheets (`sheets.ts`). */
  z.object({ type: z.literal("sheet"), action: z.unknown() }),
  /** New thread, Add project (`compose-actions.ts`) and a thread's Files sheet. */
  z.object({ type: z.literal("compose"), action: z.unknown() }),
  z.object({ type: z.literal("files"), action: z.unknown() }),
  z.object({
    type: z.literal("inbox"),
    action: z.unknown(),
    requestId: z.string().min(1).max(64),
  }),
  /** The archive browser (`archive.ts`). */
  z.object({ type: z.literal("archive"), action: z.unknown() }),
  /** The thread's live browser view (`browser-live.ts`). */
  z.object({ type: z.literal("browser"), action: z.unknown() }),
]);
let client: ClientCore | undefined;
let notifications: NotificationBridge | undefined;
let lease: Lease<ThreadSource> | undefined;
let stopThread: (() => void) | undefined;
let session: ThreadSession | undefined;
let epoch = 0;
let itemLimit = 200;
let historyAbort: AbortController | undefined;
let machine: MachineProviders | undefined;
let archive: ArchiveBrowser | undefined;
let compose: ComposeActions | undefined;
let services: NativeServices | undefined;
let terminal: NativeTerminal | undefined;
let browser: BrowserLive | undefined;
let devices: NativeDevices | undefined;
let screen: NativeScreen | undefined;
const pump = new PatchPump();
const trust = new TrustMonitor();
const sheets = new Sheets(pump, preview);
let openThreadId: string | undefined;
function error(): void {
  pump.put("error", () => ({
    type: "error",
    message: "Could not complete the request. Your saved sends remain available.",
  }));
}
async function start(json: string): Promise<void> {
  const config = Config.parse(JSON.parse(json));
  itemLimit = config.itemLimit;
  const paired = config.paired;
  client = new ClientCore({
    deviceId: config.deviceId,
    expectedHostId: config.hostId,
    limits: { items: config.itemLimit, text: 8192 },
    transport: () => nativeTransport(trust),
    credential: paired
      ? pairedCredential(nativeHttp, () => call("secret.get", paired.secretKey), trust)
      : async () =>
          z
            .union([z.strictObject({ token: z.string() }), z.strictObject({ ticket: z.string() })])
            .parse(JSON.parse(await call("credential"))),
    storage: {
      load: async () => (await call("storage.load")) || null,
      save: async (value) => {
        await call("storage.save", value);
      },
      hostBinding: {
        load: async () => (await call("storage.host.load")) || null,
        save: async (value) => {
          await call("storage.host.save", value);
        },
      },
      records: {
        load: async () => z.array(z.string()).parse(JSON.parse(await call("storage.records"))),
        write: async (id, value) => {
          await call("storage.write", { id, value });
        },
      },
    },
    scheduler,
    id: () => host.uuid(),
    random: () => host.random(),
    now: () => host.now(),
  });
  const connection = client.connectionState();
  notifications = new NotificationBridge(client, (key, read) => pump.put(key, read), scheduler.set);
  const owner = client;
  const activityGeneration = makeActivityGeneration();
  connection.subscribe(() => {
    if (connection.getSnapshot() === "ready") trust.clear();
    pump.put("connection.problem", () => ({
      type: "connection.problem",
      problem: connectionProblem(connection.getSnapshot(), owner.error, trust),
    }));
  });
  followInbox(
    client,
    config.hostId,
    pump,
    { now: () => host.now(), set: scheduler.set },
    activityGeneration,
  );
  followMachine(client, pump, trust);
  machine = new MachineProviders(client, pump);
  archive = new ArchiveBrowser(client, pump);
  compose = new ComposeActions(client, pump, preview, () => host.now());
  const featureConfig = {
    deviceId: config.deviceId,
    hostId: config.hostId,
    credential: paired
      ? pairedCredential(nativeHttp, () => call("secret.get", paired.secretKey), trust)
      : async () =>
          z
            .union([z.strictObject({ token: z.string() }), z.strictObject({ ticket: z.string() })])
            .parse(JSON.parse(await call("credential"))),
    id: () => host.uuid(),
    trust,
  };
  devices = new NativeDevices(featureConfig);
  screen = new NativeScreen(featureConfig);
  services = new NativeServices(client, pump, devices, screen);
  terminal = new NativeTerminal(client, pump);
  browser = new BrowserLive(client, pump, preview, scheduler.set, {
    agentName: (threadId, agentId) =>
      threadId === openThreadId && agentId ? agentName(lease?.store.agent(agentId)) : "An agent",
    workspaceId: (threadId) =>
      threadId === openThreadId ? lease?.store.thread?.workspaceId : undefined,
    now: () => host.now(),
    read: nativeChunks,
  });
  await client.start();
}
async function hydrate(
  owner: ClientCore,
  store: ThreadSource,
  id: string,
  generation: number,
  signal: AbortSignal,
): Promise<void> {
  // Snapshots always cap at 200. Exercise the SDK's paged history admission and delta journal.
  await new Promise<void>((resolve) => {
    if (store.thread || store.error) {
      resolve();
      return;
    }
    const cancelled = () => {
      stop();
      resolve();
    };
    const stop = store.observe(() => {
      if (store.thread || store.error) {
        stop();
        signal.removeEventListener("abort", cancelled);
        resolve();
      }
    });
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
  while (store.itemsBefore != null && store.order.length < itemLimit) {
    if (generation !== epoch || signal.aborted) return;
    await owner.loadOlder(id, Math.min(200, itemLimit - store.order.length), { signal });
  }
  if (generation === epoch)
    pump.put("thread:ready", () => ({
      type: "thread.ready",
      threadId: id,
      epoch: generation,
      count: store.order.length,
    }));
}
function action(json: string): void {
  try {
    const raw: unknown = JSON.parse(json);
    const deviceControl = NativeDeviceControl.safeParse(raw);
    if (deviceControl.success) {
      devices?.handle(deviceControl.data);
      return;
    }
    const screenControl = NativeScreenControl.safeParse(raw);
    if (screenControl.success) {
      screen?.handle(screenControl.data);
      return;
    }
    const terminalAction = NativeTerminalAction.safeParse(raw);
    if (terminalAction.success) {
      terminal?.handle(terminalAction.data);
      return;
    }
    const service = NativeServiceAction.safeParse(raw);
    if (service.success) {
      services?.handle(service.data);
      return;
    }
    const notice = NotificationAction.safeParse(raw);
    if (notice.success) {
      if (notifications) notifications.handle(notice.data);
      else error();
      return;
    }
    const value = Action.parse(raw);
    if (!client) {
      if (value.type === "command")
        pump.put(`admission:${value.requestId}`, () => ({
          type: "admission",
          id: value.requestId,
          ok: false,
          message: "Client not started. Your draft is still available.",
        }));
      else error();
      return;
    }
    switch (value.type) {
      case "open":
        services?.transcript.close();
        historyAbort?.abort();
        historyAbort = new AbortController();
        stopThread?.();
        sheets.close();
        lease?.release();
        openThreadId = value.threadId;
        lease = client.thread(value.threadId);
        session?.dispose();
        stopThread = followThread(lease.store, value.threadId, ++epoch, pump);
        session = new ThreadSession(
          client,
          lease.store,
          value.threadId,
          epoch,
          pump,
          undefined,
          itemLimit,
        );
        browser?.close();
        browser?.probe(value.threadId, epoch);
        if (itemLimit > 200) {
          const generation = epoch;
          const signal = historyAbort.signal;
          void hydrate(client, lease.store, value.threadId, generation, signal).catch(() => {
            if (generation === epoch && !signal.aborted) error();
          });
        }
        break;
      case "back":
        services?.transcript.close();
        epoch++;
        historyAbort?.abort();
        session?.dispose();
        session = undefined;
        stopThread?.();
        sheets.close();
        browser?.close();
        lease?.release();
        lease = undefined;
        openThreadId = undefined;
        break;
      case "network":
        client.networkOnline(value.online);
        break;
      case "retry":
        client.reconnectNow();
        break;
      case "machine.refresh":
        machine?.refresh();
        break;
      case "command":
        void dispatchCommand(client, value.payload, value.requestId, pump);
        break;
      case "thread":
        routeThreadAction(session, value.epoch, value.action, (key, read) => pump.put(key, read));
        break;
      case "inbox":
        inboxAction(client, value.action, value.requestId, pump);
        break;
      case "archive":
        if (!archive?.handle(value.action)) error();
        break;
      case "compose":
        if (!compose?.compose(value.action)) error();
        break;
      case "files":
        if (!compose?.files(value.action)) error();
        break;
      case "browser":
        if (!browser?.action(value.action)) error();
        break;
      case "sheet": {
        const thread =
          lease && openThreadId
            ? { owner: client, store: lease.store, threadId: openThreadId, epoch }
            : undefined;
        if (!sheets.action(thread, value.action)) error();
        break;
      }
    }
  } catch {
    error();
  }
}
Object.assign(globalThis, {
  aceStart: (json: string) => {
    void start(json).catch(error);
  },
  aceAction: action,
  aceAck: (accepted: boolean) => pump.ack(accepted),
  aceSocket: socketEvent,
  aceAccess,
});
