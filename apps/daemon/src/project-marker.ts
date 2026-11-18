import { constants } from "node:fs";
import { ProjectMarker } from "@ace/protocol";
import { openAt, type Descriptor } from "@ace/workspace/descriptor";
import { PinnedDirectory } from "@ace/workspace/pinned-directory";

/*
 * The opt-in project marker `.ace/project.json` (ADR 0181): a hint a clone carries of its
 * logical project, read as untrusted repository data and written only when the person asks.
 * Every name is opened through the project folder's held descriptor, never following a
 * symbolic link and never blocking, so a symlink, FIFO or device is never read.
 */

export const markerFolder = ".ace";
export const markerFile = "project.json";
/** The most a marker may be. */
export const markerLimit = 4096;
/** How long a read may take before the marker counts as absent. */
export const markerTimeoutMs = 500;

/** Close a descriptor in the background; a read still in flight keeps it until it settles. */
const closeLater = (file: Descriptor | undefined) => void file?.close().catch(() => undefined);

/**
 * The folder's marker, or undefined: missing, a symbolic link, not a regular file, larger than
 * `markerLimit`, slower than `timeoutMs`, unreadable, not JSON or not the schema all read as
 * absent, never as an error.
 */
export async function readMarker(
  folder: PinnedDirectory,
  timeoutMs = markerTimeoutMs,
): Promise<ProjectMarker | undefined> {
  let marker: PinnedDirectory | undefined;
  let file: Descriptor | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = (async () => {
    marker = folder.child(markerFolder);
    file = openAt(marker.fd, markerFile, constants.O_RDONLY);
    const info = await file.stat();
    if (!info.isFile() || info.size > markerLimit) return undefined;
    const bytes = Buffer.alloc(markerLimit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > markerLimit) return undefined;
    const parsed = ProjectMarker.safeParse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  })().catch(() => undefined);
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
    // A read past its time closes what it opened once it settles.
    void read.finally(() => {
      closeLater(file);
      void marker?.close().catch(() => undefined);
    });
  }
}

/** The id a registered folder's marker names, read through its own held folder; else none. */
export async function markerAt(path: string): Promise<string | undefined> {
  let folder: PinnedDirectory | undefined;
  try {
    folder = PinnedDirectory.open(path);
    return (await readMarker(folder))?.id;
  } catch {
    return undefined;
  } finally {
    await folder?.close().catch(() => undefined);
  }
}

/**
 * Why a marker wasn't written: one naming another project is there, or something at its name
 * doesn't read as a marker at all.
 */
export type MarkerRefusal = "marker_conflict" | "marker_unreadable";

/**
 * Write the folder's marker for `marker.id`, creating `.ace` when missing, through the held
 * descriptor with an exclusive create. One that already names the same id is left alone; one
 * naming another id is replaced only with `replace` (the person confirmed), else refused.
 */
export async function writeMarker(
  folder: PinnedDirectory,
  marker: ProjectMarker,
  replace: boolean,
  /** Whether an id names the same logical project here (an alias of it does too). */
  same: (id: string) => boolean = (id) => id === marker.id,
): Promise<"written" | "unchanged" | MarkerRefusal> {
  const existing = await readMarker(folder);
  if (existing && same(existing.id)) return "unchanged";
  let directory: PinnedDirectory;
  try {
    directory = folder.child(markerFolder);
  } catch (error) {
    if (!isMissing(error)) throw error;
    directory = folder.mkdir(markerFolder);
  }
  try {
    const text = `${JSON.stringify(ProjectMarker.parse(marker), null, 2)}\n`;
    try {
      await directory.writeExclusive(markerFile, text);
      return "written";
    } catch (error) {
      if (!isExisting(error)) throw error;
    }
    // Something is there: another id's marker, or a file that doesn't read as one.
    if (!replace) return existing ? "marker_conflict" : "marker_unreadable";
    directory.replace(markerFile, text);
    return "written";
  } finally {
    await directory.close();
  }
}

const codeOf = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
const isMissing = (error: unknown) => codeOf(error) === "ENOENT";
const isExisting = (error: unknown) => codeOf(error) === "EEXIST";
