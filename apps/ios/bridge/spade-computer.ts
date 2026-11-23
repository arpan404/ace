import {
  parseSpadeComputerBody,
  parseSpadeFolder,
  SpadeRequestError,
  spadeOwnFolder,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { readStaged, spadeUploadMs } from "./spade-attachments.ts";
import { spadeAtWork, spadeComputerRow, type SpadeComputerRow } from "./spade-computer-rows.ts";
import { readSpadeBytes } from "./spade-image.ts";
import {
  spadeRefused,
  spadeRequestArea,
  type SpadeAsk,
  type SpadeOutcome,
  type SpadeRefusal,
  type SpadeRequestContext,
} from "./spade-requests-area.ts";
import { segment } from "./spade-text.ts";
import { Picked } from "./thread-attachments.ts";

/*
 * A bot's computer on the iPhone (#2547; web's `computer-api.ts`, `use-bot-computer.ts` and
 * `file-manager.tsx`): who has it, Take over and Hand back, and its files. Reads go to the
 * workspace routes; every write names the revision the person saw, so Spade refuses one over a
 * file the bot changed meanwhile (`409 changed`) and the person chooses what to keep. The phone
 * checks that the person may act before it sends a change; Spade checks again.
 */

const agentId = z.string().min(1).max(256);
const path = z.string().max(4096);
/** A revision Spade gave, sent back as `base`. */
const base = z.string().min(1).max(256).optional();
/** Spade's limit on one upload (`LARGEST_UPLOAD`, `spade-server/src/api/files.rs`). */
const largestUpload = 32 * 1024 * 1024;

const at = (route: string) => `?path=${encodeURIComponent(route)}`;
const agentPath = (id: string) => `/v1/agents/${segment(id)}`;

/** Spade refused a write because the file moved on since the person saw it. */
const changed = (error: unknown) =>
  error instanceof SpadeRequestError && error.status === 409 && error.message === "changed";
const gone = (error: unknown) => error instanceof SpadeRequestError && error.status === 404;

/** A refusal; a write the file's revision refused also says `changed`. */
type FileRefusal = SpadeRefusal & { changed?: true; gone?: true };
const refusedWrite = (title: string, error: unknown): FileRefusal =>
  changed(error)
    ? {
        ok: false,
        title,
        message: "It changed since you opened it. Look again, then try once more.",
        changed: true,
      }
    : spadeRefused(title, error);

export interface SpadeFileRow {
  path: string;
  size: number;
  /** The file's text, when Spade could read it as text. */
  text: string | null;
  unreadable: "binary" | "too_large" | null;
  revision: string | null;
}

const FileBody = z.object({
  path: z.string(),
  size: z.number().catch(0).default(0),
  text: z.string().nullish().catch(null),
  unreadable: z.enum(["binary", "too_large"]).nullish().catch(null),
  revision: z.union([z.string(), z.number()]).nullish().catch(null),
});

async function readFileRow(ask: SpadeAsk, agent: string, file: string): Promise<SpadeFileRow> {
  const body = await ask("GET", `${agentPath(agent)}/workspace/file${at(file)}`);
  let parsed: z.infer<typeof FileBody>;
  try {
    parsed = FileBody.parse(JSON.parse(body));
  } catch {
    throw new Error("Spade's file didn't make sense.");
  }
  return {
    path: parsed.path,
    size: parsed.size,
    text: parsed.text ?? null,
    unreadable: parsed.unreadable ?? null,
    revision:
      parsed.revision === null || parsed.revision === undefined ? null : `${parsed.revision}`,
  };
}

/** The computer as Spade says now, as the phone draws it. */
export async function readSpadeComputer(
  { ask, spade }: Pick<SpadeRequestContext, "ask" | "spade">,
  agent: string,
): Promise<SpadeComputerRow> {
  const computer = parseSpadeComputerBody(await ask("GET", `${agentPath(agent)}/computer`));
  if (!computer) throw new Error("Spade's computer didn't make sense.");
  const bot = spade.bot(agent);
  return spadeComputerRow(computer, bot?.name ?? "The bot", spadeAtWork(bot?.state));
}

export const spadeComputerRequests = spadeRequestArea(
  [
    /** The computer, read while its pages show and again after each change of hands. */
    z.object({ type: z.literal("spade.computer"), agentId }),
    /** Take over (the bot pauses until handed back), or hand back. */
    z.object({ type: z.literal("spade.computer.take"), agentId, take: z.boolean() }),
    /** One folder of the bot's files; the workspace's own when `path` is empty. */
    z.object({ type: z.literal("spade.files.folder"), agentId, path }),
    /** A file to read or edit, with the revision a save names. */
    z.object({ type: z.literal("spade.files.file"), agentId, path }),
    /** The revision of a file the person is about to rename, move or delete. */
    z.object({ type: z.literal("spade.files.revision"), agentId, path }),
    /** Saves the text the person edited over the revision they opened. */
    z.object({
      type: z.literal("spade.files.save"),
      agentId,
      path,
      text: z.string().max(largestUpload),
      base,
    }),
    /** A file from the phone, staged by Swift, put in `folder`. */
    z.object({ type: z.literal("spade.files.upload"), agentId, folder: path, file: Picked }),
    z.object({ type: z.literal("spade.files.mkdir"), agentId, path }),
    /** Rename or move: a path with folders moves it. */
    z.object({ type: z.literal("spade.files.move"), agentId, from: path, to: path, base }),
    z.object({ type: z.literal("spade.files.delete"), agentId, path, base }),
    /** A file's bytes, for the share sheet and the viewer, in `native.attachment`'s shape. */
    z.object({ type: z.literal("spade.files.download"), agentId, path }),
  ],
  async (context, request) => {
    const { ask } = context;
    const bot = agentPath(request.agentId);
    switch (request.type) {
      case "spade.computer":
        try {
          return { ok: true as const, computer: await readSpadeComputer(context, request.agentId) };
        } catch (error) {
          return spadeRefused("Couldn't read the computer", error);
        }
      case "spade.computer.take": {
        const name = context.spade.bot(request.agentId)?.name ?? "the bot";
        const title = request.take ? "Couldn't take over" : `Couldn't hand back to ${name}`;
        try {
          await ask("POST", `${bot}/computer/${request.take ? "take-over" : "hand-back"}`);
          return { ok: true as const, computer: await readSpadeComputer(context, request.agentId) };
        } catch (error) {
          return spadeRefused(title, error);
        }
      }
      case "spade.files.folder":
        try {
          const folder = parseSpadeFolder(await ask("GET", `${bot}/workspace${at(request.path)}`));
          if (!folder) throw new Error("Spade's folder didn't make sense.");
          // Spade's own bookkeeping at the top isn't the bot's files.
          const entries = folder.entries
            .filter((entry) => request.path !== "" || entry.name !== spadeOwnFolder)
            .map(({ name, path: where, kind, size }) => ({ name, path: where, kind, size }));
          return { ok: true as const, folder: { ...folder, entries } };
        } catch (error) {
          return spadeRefused("Couldn't read the folder", error);
        }
      case "spade.files.file":
        try {
          return { ok: true as const, file: await readFileRow(ask, request.agentId, request.path) };
        } catch (error) {
          return gone(error)
            ? { ...spadeRefused("The file is gone", error), gone: true as const }
            : spadeRefused("Couldn't open the file", error);
        }
      case "spade.files.revision":
        try {
          const file = await readFileRow(ask, request.agentId, request.path);
          // Without a revision a change can't name what the person saw, and would land on
          // whatever is there by then: it isn't offered.
          if (file.revision === null) return uncheckable(file.path);
          return { ok: true as const, revision: file.revision };
        } catch (error) {
          return gone(error)
            ? {
                ok: false as const,
                title: "It's gone",
                message: "It was deleted or moved meanwhile.",
                gone: true as const,
              }
            : spadeRefused("Couldn't check the file. Try again.", error);
        }
      case "spade.files.save":
        return save(ask, request);
      case "spade.files.upload":
        return upload(context, request);
      case "spade.files.mkdir":
        return outcome(`Couldn't make ${request.path}`, () =>
          ask("POST", `${bot}/files/mkdir`, { path: request.path }),
        );
      case "spade.files.move":
        return outcome(`Couldn't move ${request.from}`, () =>
          ask("POST", `${bot}/files/move`, {
            from: request.from,
            to: request.to,
            ...(request.base ? { base: request.base } : {}),
          }),
        );
      case "spade.files.delete": {
        const since = request.base ? `&base=${encodeURIComponent(request.base)}` : "";
        const name = request.path.split("/").at(-1) ?? request.path;
        return outcome(`Couldn't delete ${name}`, () =>
          ask("DELETE", `${bot}/workspace${at(request.path)}${since}`),
        );
      }
      case "spade.files.download": {
        const name = request.path.split("/").at(-1) || "file";
        const read = await readSpadeBytes(
          context.owner,
          context.deps.id,
          `${bot}/workspace/download${at(request.path)}`,
          "application/octet-stream",
          context.signal,
        );
        return { kind: "file" as const, name, ...read };
      }
    }
  },
);

/** A file Spade gives no revision of (past the 32 MB it takes one of). */
const uncheckable = (where: string): SpadeRefusal => ({
  ok: false,
  title: "Spade can't check this file",
  message: `${where.split("/").at(-1) ?? where} is too large for Spade to tell whether it changed, so it can't be changed from the phone.`,
});

async function outcome(
  title: string,
  write: () => Promise<unknown>,
): Promise<FileRefusal | SpadeOutcome> {
  try {
    await write();
    return { ok: true };
  } catch (error) {
    return refusedWrite(title, error);
  }
}

async function save(
  ask: SpadeAsk,
  request: { agentId: string; path: string; text: string; base?: string | undefined },
): Promise<FileRefusal | { ok: true; revision: string | null }> {
  const bot = agentPath(request.agentId);
  const name = request.path.split("/").at(-1) ?? request.path;
  try {
    await ask("PUT", `${bot}/files${at(request.path)}`, {
      text: request.text,
      ...(request.base ? { base: request.base } : {}),
    });
  } catch (error) {
    return refusedWrite(`Couldn't save ${name}`, error);
  }
  // Spade answers a save with nothing: the revision is read back. When the bot wrote again in
  // between, it stays unknown, so the next save is refused rather than writing over the bot's.
  const now = await readFileRow(ask, request.agentId, request.path).catch(() => undefined);
  return { ok: true, revision: now?.text === request.text ? now.revision : null };
}

/**
 * Replacing a file names the revision there now, read just before it goes (as web reads it when
 * the file is picked), so a file the bot rewrote in between is refused, not overwritten.
 */
async function upload(
  { ask, deps, signal }: SpadeRequestContext,
  request: { agentId: string; folder: string; file: Picked },
): Promise<FileRefusal | SpadeOutcome> {
  const { file } = request;
  const title = `Couldn't upload ${file.name}`;
  if (file.bytes > largestUpload)
    return {
      ok: false,
      title,
      message: `${file.name} is larger than 32 MB, the most Spade takes.`,
    };
  const target = request.folder ? `${request.folder}/${file.name}` : file.name;
  // Replacing a file names its revision; a new one goes only while nothing is there, so a file
  // the bot makes after this check is never overwritten.
  let expect: { base: string } | { if_absent: true };
  try {
    const there = await readFileRow(ask, request.agentId, target);
    if (there.revision === null) return { ...uncheckable(target), title };
    expect = { base: there.revision };
  } catch (error) {
    if (!gone(error)) return spadeRefused("Couldn't check the file. Try again.", error);
    expect = { if_absent: true };
  }
  try {
    const data = await readStaged(deps.chunks, file, signal);
    await ask(
      "POST",
      `${agentPath(request.agentId)}/files/upload`,
      { path: target, data_b64: data, ...expect },
      spadeUploadMs(data.length),
    );
    return { ok: true };
  } catch (error) {
    return refusedWrite(title, error);
  }
}
