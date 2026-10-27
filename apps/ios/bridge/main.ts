import { host } from "./polyfills.ts";
import { ClientCore, type Lease, type ThreadSource } from "@ace/client";
import { z } from "zod";
import { DeviceId, HostId, SettingsValues } from "@ace/protocol";
import { agentName } from "@ace/ui-core";
import { call, scheduler } from "./host.ts";
import { PatchPump, followThread } from "./patches.ts";
import { LedgerShelf } from "./native-ledger.ts";
import { followInbox, inboxAction, makeActivityGeneration, type InboxFollow } from "./inbox.ts";
import { ArchiveBrowser } from "./archive.ts";
import { dispatchCommand } from "./commands.ts";
import { ThreadSession } from "./thread-session.ts";
import { routeThreadAction } from "./thread-route.ts";
import { connectionProblem, pairedCredential, TrustMonitor } from "./access.ts";
import { aceAccess, nativeHttp } from "./access-entry.ts";
import { nativeTransport, socketEvent } from "./socket.ts";
import { followMachine, MachineProviders } from "./machine-info.ts";
import { followMachineIdentity } from "./machine-identity.ts";
import { followProjectLooks } from "./project-looks.ts";
import { NotificationAction, NotificationBridge } from "./notifications.ts";
import { Sheets } from "./sheets.ts";
import { ChangesKept } from "./changes-kept.ts";
import { keptValue } from "./kept-value.ts";
import { preview } from "./presentation.ts";
import { ComposeActions } from "./compose-actions.ts";
import { ComposerSuggest, sidebarThreads } from "./composer-suggest.ts";
import { CheckoutFiles } from "./checkout-files.ts";
import { followFileChanges } from "./checkout-request.ts";
import { NativeFilesAction, routeFilesAction, type FilesActions } from "./checkout-actions.ts";
import { CheckoutDownloads } from "./checkout-downloads.ts";
import { CheckoutMemory } from "./checkout-memory.ts";
import { CheckoutUploads } from "./checkout-uploads.ts";
import { NativeServices, NativeServiceAction } from "./native-services.ts";
import { NativeReads } from "./native-reads.ts";
import { ForgeService } from "./forge-service.ts";
import { downloadFile } from "@ace/client/files";
import { NativeTerminal, NativeTerminalAction } from "./native-terminal.ts";
import { phoneDeviceStorage } from "./browser-device.ts";
import { BrowserLive } from "./browser-live.ts";
import { nativeChunks } from "./thread-attachments.ts";
import { NativeDevices, NativeDeviceControl } from "./native-devices.ts";
import { NativeScreen, NativeScreenControl } from "./native-screen.ts";
import { nativeReadSnapshots } from "./read-snapshots.ts";
import { NativeTransfers, TransferAction } from "./transfers.ts";

const Config = z.object({
  deviceId: DeviceId,
  hostId: HostId,
  itemLimit: z.number().int().min(200).max(2200),
  /** A paired machine: each socket attempt exchanges the Keychain token for a fresh ticket. */
  paired: z.strictObject({ secretKey: z.string().min(1).max(1024) }).optional(),
  /** The sort the inbox checkpoint was drawn in, so the live list opens in the same order. */
  inboxSort: SettingsValues.shape["threads.sortBy"].optional().catch(undefined),
});
const Action = z.discriminatedUnion("type", [
  /** `warm`: native kept its copy of the thread from an earlier visit (`native-ledger.ts`). */
  z.object({ type: z.literal("open"), threadId: z.string().min(1), warm: z.boolean().optional() }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("network"), online: z.boolean() }),
  z.object({
    type: z.literal("command"),
    payload: z.unknown(),
    requestId: z.string().min(1).max(64),
  }),
  z.object({ type: z.literal("retry") }),
  z.object({ type: z.literal("wake") }),
  z.object({ type: z.literal("machine.refresh") }),
  /** `epoch`: the navigation generation the action was sent for (`thread-route.ts`). */
  z.object({
    type: z.literal("thread"),
    action: z.unknown(),
    epoch: z.number().int().nonnegative().optional(),
  }),
  /** The thread's Agents and Changes sheets (`sheets.ts`). */
  z.object({ type: z.literal("sheet"), action: z.unknown() }),
  /** New thread and Add project (`compose-actions.ts`). */
  z.object({ type: z.literal("compose"), action: z.unknown() }),
  /** The composer's `@`, `/` and + lists (`composer-suggest.ts`). */
  z.object({ type: z.literal("suggest"), action: z.unknown() }),
  z.object({
    type: z.literal("inbox"),
    action: z.unknown(),
    requestId: z.string().min(1).max(64),
  }),
  /** The archive browser (`archive.ts`). */
  z.object({ type: z.literal("archive"), action: z.unknown() }),
  /** The thread's live browser view (`browser-live.ts`). */
  z.object({ type: z.literal("browser"), action: z.unknown() }),
  /** Continue on… and Open on… (`transfers.ts`). */
  z.object({ type: z.literal("transfers"), action: TransferAction }),
]);
let client: ClientCore | undefined;
let notifications: NotificationBridge | undefined;
let lease: Lease<ThreadSource> | undefined;
let stopThread: (() => void) | undefined;
let session: ThreadSession | undefined;
let epoch = 0;
let machine: MachineProviders | undefined;
let archive: ArchiveBrowser | undefined;
let compose: ComposeActions | undefined;
let suggest: ComposerSuggest | undefined;
let services: NativeServices | undefined;
let inbox: InboxFollow | undefined;
let terminal: NativeTerminal | undefined;
let browser: BrowserLive | undefined;
let devices: NativeDevices | undefined;
let screen: NativeScreen | undefined;
let transfers: NativeTransfers | undefined;
let filesActions: FilesActions | undefined;
const pump = new PatchPump();
/**
 * Native keeps the open thread and the last six it showed (`ThreadShelf.swift`); ledgers past
 * 4 Mi UTF-16 units go too, the oldest first.
 */
const ledgers = new LedgerShelf(7, 4 * 1024 * 1024);
const trust = new TrustMonitor();
const sheets = new Sheets(pump, preview, {
  kept: new ChangesKept(keptValue("review"), scheduler),
  now: () => host.now(),
  id: () => host.uuid(),
});
let openThreadId: string | undefined;
/** An agent of the thread open on the phone, named as everywhere else; undefined otherwise. */
function deviceAgent(threadId: string, agentId: string) {
  const agent = threadId === openThreadId ? lease?.store.agent(agentId) : undefined;
  return agent && { name: agentName(agent), provider: agent.native?.provider ?? "" };
}
function error(): void {
  pump.put("error", () => ({
    type: "error",
    message: "Could not complete the request. Your saved sends remain available.",
  }));
}
async function start(json: string): Promise<void> {
  const config = Config.parse(JSON.parse(json));
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
        await call("storage.save", null, value);
      },
      hostBinding: {
        load: async () => (await call("storage.host.load")) || null,
        save: async (value) => {
          await call("storage.host.save", null, value);
        },
      },
      records: {
        load: async () => z.array(z.string()).parse(JSON.parse(await call("storage.records"))),
        write: async (id, value) => {
          await call("storage.write", { id }, value ?? undefined);
        },
      },
    },
    // The inbox and opened threads paint from what this phone read last time (ADR 0030).
    readSnapshots: nativeReadSnapshots(call),
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
  inbox = followInbox(
    client,
    config.hostId,
    pump,
    { now: () => host.now(), set: scheduler.set },
    activityGeneration,
    // What the phone draws first at its next launch, before this runtime starts.
    (checkpoint) => void call("inbox.checkpoint", null, checkpoint).catch(() => {}),
    config.inboxSort,
  );
  // Each project's mark, sent once and referenced by the rows (`project-looks.ts`).
  followProjectLooks(client, pump);
  followMachine(client, pump, trust);
  followMachineIdentity(client, pump);
  machine = new MachineProviders(client, pump);
  archive = new ArchiveBrowser(client, pump);
  const reads = new NativeReads(client, pump, {
    now: () => host.now(),
    schedule: scheduler.set,
    storage: {
      load: () => call("storage.reads.load"),
      save: async (text) => {
        await call("storage.reads.save", null, text);
      },
    },
  });
  void reads.restore();
  compose = new ComposeActions(client, pump, preview, () => host.now(), nativeChunks, reads);
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
  devices = new NativeDevices(featureConfig, {
    sink: pump,
    now: () => host.now(),
    agent: (holder) => deviceAgent(holder.threadId, holder.agentId),
  });
  let machineName: string | undefined;
  screen = new NativeScreen(
    featureConfig,
    (holder) => deviceAgent(holder.threadId, holder.agentId)?.name,
    async () =>
      (machineName ??= (await owner.request({ type: "host.identity", requestId: host.uuid() }))
        .identity.displayName),
  );
  const search = compose.search;
  suggest = new ComposerSuggest({
    owner: client,
    sink: pump,
    preview,
    schedule: scheduler.set,
    now: () => host.now(),
    thread: () => {
      const thread = openThreadId ? lease?.store.thread : undefined;
      return thread && openThreadId
        ? { threadId: openThreadId, workspaceId: thread.workspaceId, provider: thread.provider }
        : undefined;
    },
    threads: () => sidebarThreads(owner),
    draft: search,
  });
  compose.newThread.readCatalogFrom((workspaceId, provider) =>
    suggest?.draftEntries(workspaceId, provider),
  );
  const memory = new CheckoutMemory(keptValue("files"), pump, scheduler);
  const files = new CheckoutFiles(
    client,
    (workspaceId, query, limit) => search.complete(workspaceId, query, limit),
    (scope) => memory.recent(scope),
  );
  filesActions = {
    memory,
    downloads: new CheckoutDownloads(client, pump, { call, uuid: () => host.uuid() }),
    uploads: new CheckoutUploads(client, pump, nativeChunks),
  };
  followFileChanges(client, pump);
  const forgeClient = client;
  services = new NativeServices(
    client,
    pump,
    devices,
    screen,
    files,
    new ForgeService(
      client,
      preview,
      () => host.now(),
      () => reads.stamp("forge"),
      () => host.uuid(),
      (input, signal) => downloadFile(forgeClient, input, { signal, timeoutMs: 60_000 }),
    ),
    reads,
  );
  terminal = new NativeTerminal(client, pump);
  transfers = new NativeTransfers(client, pump);
  browser = new BrowserLive(client, pump, preview, scheduler.set, {
    agentName: (threadId, agentId) =>
      threadId === openThreadId && agentId ? agentName(lease?.store.agent(agentId)) : "An agent",
    workspaceId: (threadId) =>
      threadId === openThreadId ? lease?.store.thread?.workspaceId : undefined,
    now: () => host.now(),
    read: nativeChunks,
    devices: phoneDeviceStorage({
      load: () => call("storage.devices.load"),
      save: async (value) => {
        await call("storage.devices.save", null, value);
      },
    }),
  });
  await client.start();
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
    const filesAction = NativeFilesAction.safeParse(raw);
    if (filesAction.success) {
      if (filesActions) routeFilesAction(filesActions, filesAction.data);
      else error();
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
        stopThread?.();
        sheets.close();
        lease?.release();
        openThreadId = value.threadId;
        lease = client.thread(value.threadId);
        session?.dispose();
        {
          const ledger = ledgers.open(value.threadId, value.warm ?? false);
          pump.bind(ledger, ++epoch);
          stopThread = followThread(lease.store, value.threadId, epoch, pump, ledger);
        }
        session = new ThreadSession(
          client,
          lease.store,
          value.threadId,
          epoch,
          pump,
          nativeChunks,
          (threadId) => suggest?.entries(threadId),
        );
        browser?.close();
        browser?.probe(value.threadId, epoch);
        transfers?.follow({ threadId: value.threadId, epoch, store: lease.store });
        break;
      case "back":
        services?.transcript.close();
        epoch++;
        pump.bind(undefined, epoch);
        ledgers.trim();
        session?.dispose();
        session = undefined;
        stopThread?.();
        sheets.close();
        browser?.close();
        transfers?.follow(undefined);
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
      case "wake":
        client.wake();
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
        inboxAction(client, value.action, value.requestId, pump, inbox);
        break;
      case "archive":
        if (!archive?.handle(value.action)) error();
        break;
      case "compose":
        if (!compose?.compose(value.action)) error();
        break;
      case "suggest":
        if (!suggest?.handle(value.action)) error();
        break;
      case "browser":
        if (!browser?.action(value.action)) error();
        break;
      case "transfers":
        if (transfers) transfers.handle(value.action);
        else error();
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
