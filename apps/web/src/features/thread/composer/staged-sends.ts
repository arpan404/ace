import type { ClientApi } from "@ace/client";
import {
  ContentPart,
  MessageContext,
  ThreadId,
  TurnOptions,
  type CommandPayload,
} from "@ace/protocol";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { z } from "zod";
import { Observable, rememberAttachments, type StagedSend } from "./send-store.ts";

/*
 * Messages held back until their files upload (UX audit SY-2, AT-2; review of #126). The person
 * pressed Enter and the composer emptied, so this is the only copy of the message until it is
 * enqueued: it is kept on this device (localStorage) and survives a reload. A message whose
 * upload failed, or whose page closed mid-upload, stays as a failed bubble with Retry and Edit,
 * whatever the composer holds by then. Files and image previews only live in the page that
 * attached them; Retry can upload a file again only there.
 */

const storedKey = "ace.sends.staged";
const storedLimit = 32;

const StoredFile = z.object({
  name: z.string(),
  mimeType: z.string(),
  bytes: z.number(),
  /** Set once the daemon holds the file. */
  sha256: z.string().optional(),
});

const Stored = z.object({
  commandId: z.string(),
  threadId: z.string(),
  text: z.string(),
  mentions: z.array(z.string()),
  input: z.array(ContentPart).optional(),
  context: MessageContext.optional(),
  attachments: z.array(StoredFile),
  options: TurnOptions.optional(),
  delivery: z.enum(["steer", "queue"]).optional(),
  /** The page that is uploading its files; another page can't finish them. */
  owner: z.string(),
  /** Why it can't go as it is, in words; undefined while its files upload. */
  failed: z.string().optional(),
});

export type { StagedSend };

/** This page, while it lives: the owner of the uploads it started. */
export let pageId: string = crypto.randomUUID();
const ownerLock = (owner: string) => `ace-staged-${owner}`;
let holdingLock = false;

/** What only this page has of a held message: its files (for Retry) and previews. */
interface Held {
  files: (File | undefined)[];
  previews: (string | undefined)[];
}
const held = new Map<string, Held>();

let storage: KeyValueStorage | undefined;
const all = new Observable<readonly StagedSend[]>([]);

function load(store: KeyValueStorage | undefined): void {
  if (storage) return;
  storage = store;
  all.seed(readJson(store, storedKey, z.array(Stored).catch([]), []));
  if (typeof addEventListener === "function")
    addEventListener("storage", (event) => {
      if (event.key === storedKey) all.set(readJson(storage, storedKey, z.array(Stored), []));
    });
}

function save(next: readonly StagedSend[]): void {
  const kept = next.slice(-storedLimit);
  all.set(kept);
  writeJson(
    storage,
    storedKey,
    // Previews are this page's: only what another page or a reload can use is kept.
    kept.map((send) =>
      Object.assign({}, send, {
        attachments: send.attachments.map(({ name, mimeType, bytes, sha256 }) =>
          sha256 ? { name, mimeType, bytes, sha256 } : { name, mimeType, bytes },
        ),
      }),
    ),
  );
}

/** Every held message on this device, with this page's previews filled in. */
export function stagedSends(store: KeyValueStorage | undefined): Observable<readonly StagedSend[]> {
  load(store);
  return all;
}

/** Hold a message while its files upload; `files` and `previews` stay in this page. */
export function stage(send: Omit<StagedSend, "owner">, local: Held): void {
  held.set(send.commandId, local);
  if (!holdingLock && typeof navigator === "object" && "locks" in navigator) {
    holdingLock = true;
    // Held until this page goes: other pages can tell its uploads are still running.
    void navigator.locks.request(ownerLock(pageId), () => new Promise<void>(() => {}));
  }
  save([...all.get().filter((s) => s.commandId !== send.commandId), { ...send, owner: pageId }]);
}

function patch(commandId: string, change: Partial<StagedSend>): void {
  save(
    all
      .get()
      .map((send) => (send.commandId === commandId ? Object.assign({}, send, change) : send)),
  );
}

/**
 * Let a held message go: it was enqueued, or taken back to edit. Its previews are freed unless
 * the transcript now shows them (`keepPreviews`).
 */
export function unstage(commandId: string, keepPreviews = false): void {
  const local = held.get(commandId);
  held.delete(commandId);
  if (local && !keepPreviews) for (const url of local.previews) if (url) URL.revokeObjectURL(url);
  if (all.get().some((send) => send.commandId === commandId))
    save(all.get().filter((send) => send.commandId !== commandId));
}

/** Whether this page can still finish (or retry) the held message's uploads. */
export function canRetry(send: StagedSend): boolean {
  const local = held.get(send.commandId);
  return send.attachments.every((file, index) => !!file.sha256 || !!local?.files[index]);
}

/** The held message's files, with this page's previews where it has them. */
export function withPreviews(send: StagedSend): StagedSend {
  const local = held.get(send.commandId);
  if (!local) return send;
  return {
    ...send,
    attachments: send.attachments.map((file, index) => ({
      ...file,
      previewUrl: local.previews[index],
    })),
  };
}

/** Other pages' uploads still running: their owners still hold their locks. */
export async function liveOwners(): Promise<ReadonlySet<string> | undefined> {
  if (typeof navigator !== "object" || !("locks" in navigator)) return undefined;
  const state = await navigator.locks.query();
  return new Set(
    (state.held ?? []).flatMap((lock) =>
      lock.name?.startsWith("ace-staged-") ? [lock.name.slice("ace-staged-".length)] : [],
    ),
  );
}

/** Why a held message from a page that closed can't go as it is. */
export function interrupted(send: StagedSend): string {
  const missing = send.attachments.filter((file) => !file.sha256).map((file) => file.name);
  return missing.length
    ? `The page closed before ${missing.join(", ")} finished uploading`
    : "The page closed before it was sent";
}

/** Record how each file's upload ended; true when every file is now held by the daemon. */
function settle(
  commandId: string,
  outcomes: readonly ({ sha256: string } | { error: string })[],
): boolean {
  const send = all.get().find((entry) => entry.commandId === commandId);
  if (!send) return false;
  const attachments = send.attachments.map((file, index) => {
    const outcome = outcomes[index];
    return outcome && "sha256" in outcome
      ? Object.assign({}, file, { sha256: outcome.sha256 })
      : file;
  });
  const failed = outcomes.flatMap((outcome, index) =>
    "error" in outcome
      ? [`${attachments[index]?.name ?? "A file"} didn't upload: ${outcome.error}`]
      : [],
  );
  patch(commandId, { attachments, failed: failed.length ? failed.join(" · ") : undefined });
  return !failed.length;
}

/**
 * Wait for a held message's uploads, then enqueue it under its own command id (its bubble
 * carries on as the outbox entry). A file that didn't upload leaves it failed, kept for Retry
 * or Edit. Resolves true once enqueued.
 */
export async function sendWhenUploaded(
  client: ClientApi,
  commandId: string,
  outcomes: Promise<readonly ({ sha256: string } | { error: string })[]>,
): Promise<boolean> {
  if (!settle(commandId, await outcomes)) return false;
  return enqueueStaged(client, commandId);
}

/** Enqueue a held message whose files the daemon all holds. */
export async function enqueueStaged(client: ClientApi, commandId: string): Promise<boolean> {
  const send = all.get().find((entry) => entry.commandId === commandId);
  if (!send || send.attachments.some((file) => !file.sha256)) return false;
  const payload: CommandPayload = {
    type: "thread.send",
    threadId: ThreadId.parse(send.threadId),
    input: send.input ?? [{ type: "text", text: send.text || "See the attached files." }],
    context: {
      ...send.context,
      mentions: send.context?.mentions ?? send.mentions.map((path) => ({ path })),
      attachments: send.attachments.flatMap((file) =>
        file.sha256 ? [{ sha256: file.sha256 }] : [],
      ),
    },
    ...(send.delivery ? { delivery: send.delivery } : {}),
    ...(send.options ? { options: send.options } : {}),
  };
  const local = withPreviews(send);
  rememberAttachments(
    local.attachments,
    local.attachments.flatMap((file) =>
      file.sha256 ? [{ sha256: file.sha256, name: file.name }] : [],
    ),
  );
  try {
    // The outbox shows it at once under the same key, so the held bubble carries on.
    const saved = client.enqueue(payload, commandId);
    await saved;
    unstage(commandId, true);
    return true;
  } catch {
    // Failed local writes are only held in outbox memory. Preserve the durable held copy.
    patch(commandId, { failed: "This device couldn't save the message" });
    return false;
  }
}

/** Upload a held message's failed files again (in the page that has them), then send it. */
export async function retryStaged(
  client: ClientApi,
  commandId: string,
  upload: (file: File) => Promise<{ sha256: string }>,
): Promise<boolean> {
  const send = all.get().find((entry) => entry.commandId === commandId);
  const local = held.get(commandId);
  if (!send) return false;
  patch(commandId, { failed: undefined, owner: pageId });
  const outcomes = await Promise.all(
    send.attachments.map(async (file, index) => {
      if (file.sha256) return { sha256: file.sha256 };
      const original = local?.files[index];
      if (!original) return { error: "it isn't on this page any more" };
      try {
        return { sha256: (await upload(original)).sha256 };
      } catch (error) {
        return { error: error instanceof Error && error.message ? error.message : "it failed" };
      }
    }),
  );
  return settle(commandId, outcomes) && enqueueStaged(client, commandId);
}

/** Test seam: what a reload does to this page (its files, previews and id go; storage stays). */
export function reloadPage(): void {
  held.clear();
  storage = undefined;
  all.seed([]);
  holdingLock = false;
  pageId = crypto.randomUUID();
}

/** Test seam: forget every held message. */
export function resetStaged(): void {
  for (const commandId of held.keys()) unstage(commandId);
  storage = undefined;
  all.seed([]);
}
