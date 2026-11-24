import { ThreadId } from "@ace/protocol";
import { filtered, host, tree, unplaced, type Operation, type Resource } from "./decide.ts";

/*
 * What each socket message is, for the access policy (ADR 0209 §4.1, "JSON socket messages",
 * "Dedicated channels"). A type listed nowhere here is unclassified, and `decide` refuses it on
 * an org host: a new message type is closed to members until someone classifies it. Pure.
 */

type Rule = Operation | ((message: Readonly<Record<string, unknown>>) => Operation);

const exact: Readonly<Record<string, Rule>> = {
  hello: "session",
  ping: "session",
  unsubscribe: "session",
  "presence.update": "session",
  "account.grant.refresh": "session",
  "account.standing": "session",
  "device.standing": "session",
  // Each checks the owner's proven standing itself.
  "account.owner.release": "host.admin",
  "account.owner.enroll": "host.admin",
  "account.owner.enroll.confirm": "host.admin",

  "host.identity": "host.meta",
  "diagnostics.health": "host.meta",
  "appUpdate.request": "host.meta",
  "machineUpdate.request": "host.meta",
  "icons.read": "host.meta",
  "icons.resolve": "host.meta",
  "avatars.resolve": "host.meta",
  "permissions.capabilities": "host.meta",
  "onboarding.query": "host.meta",
  "onboarding.dismiss": "host.meta",
  "search.status": "host.meta",

  "diagnostics.request": "host.admin",
  "admission.request": "host.admin",
  "storage.request": "host.admin",
  "projects.request": "host.admin",
  "devices.request": "host.admin",
  "devices.ack": "host.admin",
  "outside.request": "host.admin",
  "user_browser.settings": "host.admin",
  "machine.code.clear": "host.admin",
  "machine.code.set": "host.admin",
  "machine.code.status": "host.admin",
  "provider.logout": "host.admin",
  "providers.request": "host.admin",
  "marketplace.request": "host.admin",
  pluginRequest: "host.admin",
  suitRequest: "host.admin",
  suitWatch: "host.admin",
  suitReport: "host.admin",

  "terminal.request": "host.shell",
  "terminal.credit": "host.shell",

  subscribe: "tree.read",
  "threads.page": "tree.read",
  "items.page": "tree.read",
  "items.window": "tree.read",
  "entities.page": "tree.read",
  "turns.page": "tree.read",
  "turn.steps": "tree.read",
  "item.raw": "tree.read",
  "output.read": "tree.read",
  "interaction.read": "tree.read",
  "thread.catchUp": "tree.read",
  "thread.readState": "tree.read",
  "thread.search": "tree.read",
  "search.query": "tree.read",
  "activity.reads": "tree.read",
  "activity.markRead": "tree.read",
  "context.request": "tree.read",
  "preview.request": "tree.read",
  "queue.get": "tree.read",
  "command.status": "tree.read",
  "commands.list": "tree.read",
  "commands.resolve": "tree.read",
  "catalog.list": "tree.read",
  "catalog.unsubscribe": "session",
  "notification.feed": "tree.read",
  "notification.ack": "tree.read",
  "notification.register": "tree.read",
  "notification.unregister": "session",
  "notification.snooze": "tree.read",
  "notification.config": "tree.read",
  "notification.preferences": "tree.read",
  "automation.list": "tree.read",
  "automation.inbox": "tree.read",
  "browser.subscribe": "tree.read",
  "browser.unsubscribe": "session",
  "browser.tabs.list": "tree.read",
  "browser.downloads.list": "tree.read",
  "browser.download.read": "tree.read",
  "browser.browsing.watch": "tree.read",

  "cli.request": "tree.write",
  "pi.control": "tree.write",
  "workspace.request": "tree.write",
  "source-control.request": "tree.write",
  "repositories.request": "tree.write",
  "verify.request": "tree.write",
  "skills.request": "tree.write",
  "skills.unsubscribe": "session",
  "prompts.request": "tree.write",

  "worktree.creation.request": "tree.create",
  "history.list": "tree.create",
  "history.import": "tree.create",
  "history.continue": "tree.create",
  "history.release": "tree.create",
  "automation.put": "tree.create",
  "automation.remove": "tree.create",
  "automation.run": "tree.create",
  "automation.retry": "tree.create",
  "automation.setEnabled": "tree.create",
  "automation.webhook": "tree.create",

  "machines.request": "fleet.link",
  "machine.call": "fleet.link",
  "machine.cancel": "fleet.link",
  "spade.machines": "fleet.link",
  "spade.remote": "fleet.link",
  "machine.transfer": "transfer",
  "transfers.request": "transfer",
  "pair.redeem": "pairing",
  "fleet.request": (message) =>
    fleetOperations[String(Reflect.get(Object(message["operation"]), "op"))] ?? "fleet.link",

  "screen.request": "computer",
  "screen.ack": "computer",
  "computer.using.watch": "computer",
  "media.connect": "computer",
  "spade.computer.drive": "computer",
  "spade.computer.get": "computer",

  command: (message) => commandOperation(message["command"]),
};

/** Families classified by prefix, for types not listed exactly. Longest prefix first. */
const prefixes: readonly (readonly [string, Operation])[] = [
  ["browser.backend.", "host.admin"],
  ["user_browser.", "host.admin"],
  ["browser.", "tree.write"],
  ["spade.", "spade"],
  ["settings.", "host.admin"],
  ["accounts.", "host.admin"],
  ["provider.accounts.", "host.admin"],
  ["provider.login.", "host.admin"],
  ["provider.install.", "host.admin"],
  ["cursor.auth.", "host.admin"],
  ["lockedUse.", "host.admin"],
  ["registry.", "host.admin"],
  ["mcp.", "host.admin"],
  ["models.", "host.meta"],
  ["usage.", "host.meta"],
  ["files.", "host.shell"],
];

/** `fleet.request` carries pairing and device care as well as fleet links. */
const fleetOperations: Readonly<Record<string, Operation>> = {
  pairing: "pairing",
  pairings: "pairing",
  cancelPairing: "pairing",
  devices: "host.admin",
  revoke: "host.admin",
  revokeOthers: "host.admin",
  scope: "host.admin",
  remoteStatus: "host.meta",
};

const payloadOperations: Readonly<Record<string, Operation>> = {
  "thread.create": "tree.create",
  "thread.interrupt": "tree.stop",
};

function commandOperation(command: unknown): Operation {
  const payload = Reflect.get(Object(command), "payload");
  const type = String(Reflect.get(Object(payload), "type") ?? "");
  return payloadOperations[type] ?? "tree.write";
}

/** The operation a socket message asks for, or undefined when nobody classified its type. */
export function socketOperation(message: { type: string }): Operation | undefined {
  const fields: Readonly<Record<string, unknown>> = message;
  const rule =
    exact[message.type] ?? prefixes.find(([prefix]) => message.type.startsWith(prefix))?.[1];
  return typeof rule === "function" ? rule(fields) : rule;
}

const threadOf = (value: unknown): ThreadId | undefined => {
  const parsed = ThreadId.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/**
 * Lists whose service filters every entry to the trees the socket may read (`filtered`). The
 * notification feed rechecks each alert and retraction with the socket's `canReadThread`.
 */
const selfFiltering: ReadonlySet<string> = new Set(["notification.feed"]);

/**
 * The resource a message names. A tree operation names the thread it carries (top level, in a
 * subscription's scope, a terminal's operation or a command's payload); one that names none
 * (a whole list, a search) can't be placed, and the policy refuses it to members until the access
 * table can filter it.
 */
export function socketResource(message: { type: string }, operation: Operation): Resource {
  if (!operation.startsWith("tree.")) return host;
  if (operation === "tree.read" && selfFiltering.has(message.type)) return filtered;
  const fields: Readonly<Record<string, unknown>> = message;
  const nested = (key: string) => Reflect.get(Object(fields[key]), "threadId");
  const payload = Reflect.get(Object(fields["command"]), "payload");
  const thread =
    threadOf(fields["threadId"]) ??
    threadOf(nested("scope")) ??
    threadOf(nested("operation")) ??
    threadOf(Reflect.get(Object(payload), "threadId"));
  if (thread !== undefined) return tree({ thread });
  const interaction = Reflect.get(Object(payload), "interactionId");
  if (typeof interaction === "string") return tree({ interaction });
  const task = Reflect.get(Object(payload), "taskId");
  if (typeof task === "string") return tree({ task });
  return unplaced;
}

/** What opening a dedicated channel is (hello `channel`). */
export function channelOperation(channel: string | undefined): Operation | undefined {
  switch (channel) {
    case undefined:
      return "session";
    case "files":
      return "host.shell";
    case "devices":
    case "provider_auth":
      return "host.admin";
    case "browser":
      return "tree.write";
    case "screen":
    case "media":
      return "computer";
    case "machine":
    case "tunnel":
      return "fleet.link";
    default:
      return undefined;
  }
}
