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
import { withBrowserLock } from "@/boot/web-locks.ts";
import { z } from "zod";
import { readDraft } from "./draft-store.ts";
import { releaseUploadFiles } from "./release-upload-files.ts";
import { rememberAttachments, type StagedSend } from "./send-store.ts";
import {
  browserUploadClock,
  claimUpload,
  holdsUpload,
  releaseUpload,
  startRemoval,
  uploadIsInterrupted,
  uploadRecoverable,
  type UploadClock,
  type UploadHere,
  type UploadToken,
} from "./upload-interruption.ts";

/* Messages reserve their place before uploading. Files and previews stay in this tab.
 * Ownership, claims and fencing across tabs follow `upload-interruption.ts`: a page that
 * closes, reloads or outlives its lease leaves the message interrupted, and any page may then
 * claim it for Retry, Edit or Remove. Nothing is resent unless someone chooses Retry.
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
  owner: z.string().optional(),
  fence: z.number().int().nonnegative().safe().optional(),
  removing: z.boolean().optional(),
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
// This page's identity in ownership records. A reload is a new page.
const newPage = () => `page-${crypto.randomUUID()}`;
let page = newPage();
let watchingClose = false;

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
function find(commandId: string): StagedSend | undefined {
  return all.get().find((entry) => entry.commandId === commandId);
}
function here(commandId: string, now: number): UploadHere {
  return { page, holdsFiles: held.has(commandId), now };
}
/** One record's read-decide-write runs alone across tabs wherever the browser has Web Locks. */
function exclusive<T>(commandId: string, run: () => T): Promise<T> {
  return withBrowserLock(`ace.sends.staged:${commandId}`, () => {
    refreshHeldSends();
    return run();
  });
}

/** Every held message, validated for rendering and submission. */
export function stagedSends(store: KeyValueStorage | undefined): typeof all {
  heldSendStore(store);
  if (!watchingClose && typeof addEventListener === "function") {
    watchingClose = true;
    addEventListener("pagehide", releasePage);
  }
  return all;
}

/** Closing or reloading frees this page's unfinished uploads for other pages at once. */
function releasePage(): void {
  refreshHeldSends();
  for (const send of all.get()) {
    const released = releaseUpload(send, page);
    if (released) save(released);
  }
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
      owner: page,
      fence: 0,
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
  const send = find(commandId);
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

/** Change the record only while `token` still owns it. */
function patchHeld(commandId: string, token: UploadToken, change: Partial<StagedSend>): boolean {
  refreshHeldSends();
  const send = find(commandId);
  return !!send && holdsUpload(send, token) && patch(commandId, change);
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

export function isInterrupted(send: StagedSend, now: number): boolean {
  return uploadIsInterrupted(send, here(send.commandId, now));
}
/** Retry, Edit or Remove may act on it here: it failed or stopped, and nobody works on it. */
export function isRecoverable(send: StagedSend, now: number): boolean {
  return uploadRecoverable(send, here(send.commandId, now));
}

/** Take the message over for a recovery; undefined while another page holds it. */
function claim(
  commandId: string,
  clock: UploadClock,
): Promise<{ send: StagedSend; token: UploadToken } | undefined> {
  return exclusive(commandId, () => {
    const send = find(commandId);
    const claimed = send && claimUpload(send, here(commandId, clock.now()));
    if (!claimed) return undefined;
    if (!save(claimed)) {
      // Storage refused the claim. This page may still act on its own message in memory, as
      // it could before; another page's message stays theirs.
      if (send.owner !== page) return undefined;
      retainHeldSend(claimed, claimed);
    }
    const local = held.get(commandId);
    if (local) local.clock = clock;
    else held.set(commandId, { files: [], previews: [], clock });
    return { send: claimed, token: { page, fence: claimed.fence ?? 0 } };
  });
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
  token: UploadToken,
  outcomes: readonly ({ sha256: string } | { error: string })[],
): boolean {
  const send = find(commandId);
  // Another page claimed or removed it meanwhile: this late callback has no say.
  if (!send || !holdsUpload(send, token)) return false;
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
 * or Edit. Only the page that staged it, still owning it, settles it. Resolves true once
 * enqueued.
 */
export async function sendWhenUploaded(
  client: ClientApi,
  commandId: string,
  outcomes: Promise<readonly ({ sha256: string } | { error: string })[]>,
  storage?: KeyValueStorage,
): Promise<boolean> {
  refreshHeldSends();
  const original = find(commandId);
  if (!original || original.owner !== page) return false;
  const token = { page, fence: original.fence ?? 0 };
  return settleWhenUploaded(client, original, token, outcomes, storage);
}

async function settleWhenUploaded(
  client: ClientApi,
  original: StagedSend,
  token: UploadToken,
  outcomes: Promise<readonly ({ sha256: string } | { error: string })[]>,
  storage: KeyValueStorage | undefined,
): Promise<boolean> {
  const { commandId } = original;
  const epoch = generation;
  const uploaded = await outcomes;
  if (epoch !== generation) return false;
  refreshHeldSends();
  const current = find(commandId);
  if (!current || current.removing) {
    // Removed while uploading: what arrived late belongs to nobody.
    await releaseUploadFiles(
      client,
      original.threadId,
      uploaded.flatMap((file) => ("sha256" in file ? [file.sha256] : [])),
      () => retainedHashes(client, original, storage),
    );
    return false;
  }
  if (!(await exclusive(commandId, () => settle(commandId, token, uploaded)))) return false;
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
    if (pending?.state === "saving" || !ready(send)) return;
    if (!(await enqueueReady(client, send.commandId))) return;
    passed.add(send.commandId);
  }
}

/** Complete, and nobody is uploading, recovering or removing it. */
function ready(send: StagedSend): boolean {
  return (
    !send.preparing &&
    !send.removing &&
    !send.uploadInterrupted &&
    !send.failed &&
    send.attachments.every((file) => !!file.sha256)
  );
}

/** A ready message may wait behind an earlier upload or failed local save. */
export async function enqueueStaged(client: ClientApi, commandId: string): Promise<boolean> {
  const send = find(commandId);
  if (!send) return false;
  await drainStaged(client, send.threadId);
  return !all.get().some((entry) => entry.commandId === commandId);
}

async function enqueueReady(client: ClientApi, commandId: string): Promise<boolean> {
  refreshHeldSends();
  const send = find(commandId);
  if (!send || !ready(send)) return false;
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
    // The outbox shows it at once under the same key, so the held bubble carries on. The
    // command id is the daemon's idempotency key, so a second enqueue can't deliver it twice.
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

/**
 * Claim a failed or interrupted message and send it again: complete payloads go as they are;
 * files still to upload are uploaded from this page's copies. A file this page doesn't have
 * leaves it failed, saying so, for Edit or Remove. False when another page holds it.
 */
export async function retryStaged(
  client: ClientApi,
  commandId: string,
  upload: (file: File) => Promise<{ sha256: string }>,
  clock: UploadClock = browserUploadClock,
  storage?: KeyValueStorage,
): Promise<boolean> {
  const claimed = await claim(commandId, clock);
  if (!claimed) return false;
  const { send, token } = claimed;
  if (send.attachments.every((file) => !!file.sha256)) {
    if (!patchHeld(commandId, token, { preparing: false, failed: undefined })) return false;
    return enqueueStaged(client, commandId);
  }
  // Its bubble reads as uploading again while this page tries.
  if (!patchHeld(commandId, token, { failed: undefined })) return false;
  const local = held.get(commandId);
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
  return settleWhenUploaded(client, send, token, outcomes, storage);
}

/**
 * Claim a failed or interrupted message and hand it to `take` (the composer), which returns
 * true once it holds the draft. Only then is the message let go; otherwise it stays as it was.
 * False when another page holds it or the composer couldn't take it.
 */
export async function editStaged(
  commandId: string,
  take: (send: StagedSend) => boolean,
  clock: UploadClock = browserUploadClock,
): Promise<boolean> {
  const claimed = await claim(commandId, clock);
  if (!claimed) return false;
  const { send, token } = claimed;
  if (take(withPreviews(send))) {
    const released = await exclusive(
      commandId,
      () => holdsUpload(find(commandId) ?? send, token) && unstage(commandId),
    );
    if (released) return true;
  }
  // Not taken: it stays here, not sent, for anyone to act on again.
  await exclusive(commandId, () => patchHeld(commandId, token, { preparing: false }));
  return false;
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

/**
 * Remove one interrupted/failed submission. Repeated removal cannot touch its successors, and
 * a message another page is uploading or recovering is left alone.
 */
export async function removeStagedUpload(
  client: ClientApi,
  commandId: string,
  storage: KeyValueStorage | undefined,
  clock: UploadClock = browserUploadClock,
): Promise<boolean> {
  refreshHeldSends();
  if (!find(commandId)) return true;
  const send = await exclusive(commandId, () => {
    const current = find(commandId);
    // Gone, finished, or held by a live page: nothing for this Remove to do.
    const removing = current && startRemoval(current, here(commandId, clock.now()));
    if (!current || !removing) return "untouched";
    return removing === current || patch(commandId, removing) ? removing : undefined;
  });
  if (send === "untouched") return true;
  if (!send) return false;
  const released = new Set<string>();
  while (true) {
    refreshHeldSends();
    const current = find(commandId);
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
  if (find(commandId) && !unstage(commandId)) return false;
  await drainStaged(client, send.threadId);
  return true;
}

function forgetPage(): void {
  generation++;
  drains = new WeakMap();
  if (watchingClose && typeof removeEventListener === "function")
    removeEventListener("pagehide", releasePage);
  watchingClose = false;
  page = newPage();
  records = undefined;
  parsed = [];
}

/** Test seam: what a reload does to this page (it lets go of its uploads; storage stays). */
export function reloadPage(): void {
  releasePage();
  held.clear();
  forgetPage();
  reloadHeldStore();
}

/** Test seam: the page dies without saying so (a crash); only its lease can free its uploads. */
export function crashPage(): void {
  held.clear();
  forgetPage();
  reloadHeldStore();
}

/** Test seam: forget every held message. */
export function resetStaged(): void {
  for (const commandId of held.keys()) unstage(commandId);
  forgetPage();
  reloadHeldStore();
}
