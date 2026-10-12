import type { ClientApi } from "@ace/client";
import {
  ContentPart,
  MessageContext,
  ThreadId,
  TurnOptions,
  type CommandPayload,
} from "@ace/protocol";
import type { KeyValueStorage } from "@ace/ui-core";
import {
  heldSendStore,
  saveHeldSend,
  retainHeldSend,
  deleteHeldSend,
  refreshHeldSends,
  reloadHeldStore,
} from "@/lib/held-send-store.ts";
import { z } from "zod";
import { readDraft } from "./draft-store.ts";
import { releaseUploadFiles } from "./release-upload-files.ts";
import { rememberAttachments, type StagedSend } from "./send-store.ts";
import {
  browserUploadClock,
  uploadIsInterrupted,
  type UploadClock,
} from "./upload-interruption.ts";

/* Messages reserve their place before uploading. Files and previews stay in this tab.
 * Reloads and timeouts leave an interrupted message with Remove only; they never resend it.
 */

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
  submissionOrder: z.number().int().nonnegative().safe().optional(),
  preparing: z.boolean().optional(),
  uploadStartedAt: z.number().int().nonnegative().safe().optional(),
  uploadInterrupted: z.boolean().optional(),
  text: z.string(),
  mentions: z.array(z.string()),
  input: z.array(ContentPart).optional(),
  context: MessageContext.optional(),
  attachments: z.array(StoredFile),
  options: TurnOptions.optional(),
  delivery: z.enum(["steer", "queue"]).optional(),
  /** Why it can't go as it is, in words; undefined while its files upload. */
  failed: z.string().optional(),
});

export type { StagedSend };

/** What only this page has of a held message: its files (for Retry) and previews. */
interface Held {
  files: (File | undefined)[];
  previews: (string | undefined)[];
  clock: UploadClock;
}
const held = new Map<string, Held>();
let generation = 0;

// Full payloads are a cached projection of the same backing records as recovery facts.
let records: ReturnType<ReturnType<typeof heldSendStore>["get"]> | undefined;
let parsed: readonly StagedSend[] = [];
const all = {
  subscribe(listener: () => void) {
    return heldSendStore(undefined).subscribe(listener);
  },
  get(): readonly StagedSend[] {
    const next = heldSendStore(undefined).get();
    if (next !== records) {
      records = next;
      parsed = next.flatMap((record) => {
        const result = Stored.safeParse(record.value);
        return result.success ? [result.data] : [];
      });
    }
    return parsed;
  },
};
function save(send: StagedSend): boolean {
  return saveHeldSend(send, {
    ...send,
    attachments: send.attachments.map(({ name, mimeType, bytes, sha256 }) =>
      sha256 ? { name, mimeType, bytes, sha256 } : { name, mimeType, bytes },
    ),
  });
}
/** Every held message, validated for rendering and submission. */
export function stagedSends(store: KeyValueStorage | undefined): typeof all {
  heldSendStore(store);
  return all;
}

/** Hold a message while its files upload; `files` and `previews` stay in this page. */
export function stage(
  send: StagedSend,
  local: Pick<Held, "files" | "previews">,
  clock: UploadClock = browserUploadClock,
): boolean {
  const uploading = send.preparing || send.attachments.some((file) => !file.sha256);
  held.set(send.commandId, { ...local, clock });
  if (
    !save({
      ...send,
      preparing: !!uploading,
      uploadStartedAt: uploading ? clock.now() : undefined,
    })
  ) {
    held.delete(send.commandId);
    return false;
  }
  return true;
}

function patch(commandId: string, change: Partial<StagedSend>): boolean {
  refreshHeldSends();
  const send = all.get().find((entry) => entry.commandId === commandId);
  if (!send) return false;
  const next = { ...send, ...change };
  if (save(next)) return true;
  const failed = {
    ...next,
    failed: [
      change.failed,
      "This device couldn't save the upload results. Free space, then Retry or Edit.",
    ]
      .filter(Boolean)
      .join(" · "),
  };
  retainHeldSend(failed, failed);
  return false;
}

/**
 * Let a held message go: it was enqueued, or taken back to edit. Its previews are freed unless
 * the transcript now shows them (`keepPreviews`).
 */
export function unstage(commandId: string, keepPreviews = false): boolean {
  if (!deleteHeldSend(commandId)) return false;
  const local = held.get(commandId);
  held.delete(commandId);
  if (local && !keepPreviews) for (const url of local.previews) if (url) URL.revokeObjectURL(url);
  return true;
}

/** Whether this page can still finish (or retry) the held message's uploads. */
export function canRetry(send: StagedSend): boolean {
  const local = held.get(send.commandId);
  return send.attachments.every((file, index) => !!file.sha256 || !!local?.files[index]);
}

/** Only this page's retained files can be edited back into its composer. */
export function hasLocalStaged(commandId: string): boolean {
  return held.has(commandId);
}
export function isInterrupted(send: StagedSend, now: number): boolean {
  return uploadIsInterrupted(send, held.has(send.commandId), now);
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

/** Record how each file's upload ended; true when every file is now held by the daemon. */
function settle(
  commandId: string,
  outcomes: readonly ({ sha256: string } | { error: string })[],
): boolean {
  refreshHeldSends();
  const send = all.get().find((entry) => entry.commandId === commandId);
  if (!send) {
    return false;
  }
  const stopped = isInterrupted(send, held.get(commandId)?.clock.now() ?? 0);
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
  const saved = patch(commandId, {
    preparing: false,
    uploadInterrupted: stopped || undefined,
    attachments,
    failed: failed.length ? failed.join(" · ") : undefined,
  });
  return saved && !failed.length && !stopped;
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
  storage?: KeyValueStorage,
): Promise<boolean> {
  const epoch = generation;
  const original = all.get().find((send) => send.commandId === commandId);
  const uploaded = await outcomes;
  if (epoch !== generation) return false;
  refreshHeldSends();
  if (original && !all.get().some((send) => send.commandId === commandId)) {
    await releaseUploadFiles(
      client,
      original.threadId,
      uploaded.flatMap((file) => ("sha256" in file ? [file.sha256] : [])),
      () => retainedHashes(client, original, storage),
    );
    return false;
  }
  if (!settle(commandId, uploaded)) return false;
  return enqueueStaged(client, commandId);
}

// One drain per client and thread; each enqueue must be durably saved before its successor.
let drains = new WeakMap<ClientApi, Map<string, Promise<void>>>();

/** Move ready messages into the outbox in persisted submission order. */
export function drainStaged(client: ClientApi, threadId: string): Promise<void> {
  let threads = drains.get(client);
  if (!threads) {
    threads = new Map();
    drains.set(client, threads);
  }
  const epoch = generation;
  const active = threads.get(threadId);
  if (active)
    return active.then(() => (epoch === generation ? drainStaged(client, threadId) : undefined));
  const slots = threads;
  const running = drainThread(client, threadId, generation).finally(() => slots.delete(threadId));
  threads.set(threadId, running);
  return running;
}

async function drainThread(client: ClientApi, threadId: string, epoch: number): Promise<void> {
  const passed = new Set<string>();
  while (true) {
    if (epoch !== generation) return;
    const send = all
      .get()
      .find((entry) => entry.threadId === threadId && !passed.has(entry.commandId));
    if (!send) return;
    const pending = client
      .pendingSends(threadId)
      .getSnapshot()
      .find((entry) => entry.commandId === send.commandId);
    if (pending && pending.state !== "saving" && pending.state !== "failed") {
      passed.add(send.commandId);
      unstage(send.commandId, true);
      continue;
    }
    if (
      pending?.state === "saving" ||
      send.preparing ||
      send.uploadInterrupted ||
      send.failed ||
      send.attachments.some((file) => !file.sha256)
    )
      return;
    if (!(await enqueueReady(client, send.commandId))) return;
    passed.add(send.commandId);
  }
}

/** A ready message may wait behind an earlier upload or failed local save. */
export async function enqueueStaged(client: ClientApi, commandId: string): Promise<boolean> {
  const send = all.get().find((entry) => entry.commandId === commandId);
  if (!send) return false;
  await drainStaged(client, send.threadId);
  return !all.get().some((entry) => entry.commandId === commandId);
}

async function enqueueReady(client: ClientApi, commandId: string): Promise<boolean> {
  refreshHeldSends();
  const send = all.get().find((entry) => entry.commandId === commandId);
  if (!send || send.uploadInterrupted || send.attachments.some((file) => !file.sha256))
    return false;
  const payload: CommandPayload = {
    type: "thread.send",
    threadId: ThreadId.parse(send.threadId),
    input: send.input ?? [{ type: "text", text: send.text }],
    context: {
      ...send.context,
      mentions: send.context?.mentions ?? send.mentions.map((path) => ({ path })),
      attachments: [
        ...new Set(send.attachments.flatMap((file) => (file.sha256 ? [file.sha256] : []))),
      ].map((sha256) => ({ sha256 })),
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
  clock: UploadClock = browserUploadClock,
  storage?: KeyValueStorage,
): Promise<boolean> {
  refreshHeldSends();
  const send = all.get().find((entry) => entry.commandId === commandId);
  const local = held.get(commandId);
  if (!send) return false;
  if (isInterrupted(send, clock.now())) return false;
  if (local) local.clock = clock;
  if (
    !patch(commandId, {
      preparing: true,
      uploadStartedAt: clock.now(),
      failed: undefined,
    })
  )
    return false;
  const outcomes = Promise.all(
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
  return sendWhenUploaded(client, commandId, outcomes, storage);
}

function retainedHashes(
  client: ClientApi,
  removed: StagedSend,
  storage: KeyValueStorage | undefined,
): ReadonlySet<string> {
  refreshHeldSends();
  return new Set([
    ...all
      .get()
      .filter((send) => send.commandId !== removed.commandId && send.threadId === removed.threadId)
      .flatMap((send) => send.attachments.flatMap((file) => (file.sha256 ? [file.sha256] : []))),
    ...(readDraft(storage, `thread:${removed.threadId}`)?.attachments.map((file) => file.sha256) ??
      []),
    ...client
      .pendingSends(removed.threadId)
      .getSnapshot()
      .flatMap((send) =>
        send.payload.type === "thread.send"
          ? (send.payload.context?.attachments.map((file) => file.sha256) ?? [])
          : [],
      ),
  ]);
}

/** Remove one interrupted/failed submission. Repeated removal cannot touch its successors. */
export async function removeStagedUpload(
  client: ClientApi,
  commandId: string,
  storage: KeyValueStorage | undefined,
  clock: UploadClock = browserUploadClock,
): Promise<boolean> {
  refreshHeldSends();
  const send = all.get().find((entry) => entry.commandId === commandId);
  if (!send) return true;
  // A stale Remove from another tab must not delete a message that has already finished.
  if (!send.failed && !isInterrupted(send, clock.now())) return true;
  if (!patch(commandId, { uploadInterrupted: true })) return false;
  const released = new Set<string>();
  while (true) {
    refreshHeldSends();
    const current = all.get().find((entry) => entry.commandId === commandId);
    const hashes =
      current?.attachments.flatMap((file) =>
        file.sha256 && !released.has(file.sha256) ? [file.sha256] : [],
      ) ?? [];
    if (!hashes.length) break;
    if (
      !(await releaseUploadFiles(client, send.threadId, hashes, () =>
        retainedHashes(client, send, storage),
      ))
    )
      return false;
    for (const hash of hashes) released.add(hash);
  }
  if (!unstage(commandId)) return false;
  await drainStaged(client, send.threadId);
  return true;
}

/** Test seam: what a reload does to this page (its files and previews go; storage stays). */
export function reloadPage(): void {
  generation++;
  drains = new WeakMap();
  held.clear();
  records = undefined;
  parsed = [];
  reloadHeldStore();
}

/** Test seam: forget every held message. */
export function resetStaged(): void {
  generation++;
  drains = new WeakMap();
  for (const commandId of held.keys()) unstage(commandId);
  records = undefined;
  parsed = [];
  reloadHeldStore();
}
