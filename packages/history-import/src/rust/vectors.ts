import { encodeFrames } from "./frames.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const frames = (message: unknown, id = 0) => encodeFrames(message, id).map(hex);

/** Messages the daemon sends ace-history, as frames, with the message each must read as. */
const envelope = (id: number, request: unknown) => ({ id, request });
function toReader() {
  const cases: { name: string; message: unknown; id?: number }[] = [
    { name: "init", message: { init: { indexPath: "/ace/index.sqlite", instances: [] } } },
    { name: "cancel", message: "cancel" },
    { name: "scan", message: envelope(1, { op: "scan" }), id: 1 },
    {
      name: "list",
      message: envelope(2, {
        op: "list",
        request: {
          type: "history.list",
          cwd: "/w",
          limit: 50,
          before: { lastActivity: 5, id: "a" },
        },
        exclude: ["claude:x"],
      }),
      id: 2,
    },
    {
      name: "blob-chunk",
      message: envelope(3, {
        op: "archive.write",
        command: { type: "blob.chunk", id: "b", bytes: new Uint8Array([0, 1, 2, 255]) },
      }),
      id: 3,
    },
    {
      name: "import",
      message: envelope(4, {
        op: "import",
        init: { sourceId: "s", threadId: "t", workspaceId: "w", agentId: "a", at: 7 },
      }),
      id: 4,
    },
  ];
  return cases.map(({ name, message, id }) => ({
    name,
    frames: frames(message, id),
    message: JSON.parse(
      JSON.stringify(message, (_k, v: unknown) => (v instanceof Uint8Array ? hex(v) : v)),
    ),
  }));
}

/** Messages ace-history sends, as the frames it must write and the daemon reads. */
function fromReader() {
  const cases: { name: string; message: unknown; id?: number }[] = [
    { name: "ready", message: { id: 0, value: "ready" } },
    { name: "error", message: { id: 5, error: "History operation already in progress" }, id: 5 },
    {
      name: "progress",
      message: {
        progress: 64,
        result: { files: 64, reads: 3, bytes: 10, skipped: 61, unsupported: [] },
      },
    },
    {
      name: "refused",
      message: { refused: { code: "incompatible-data", path: "/ace/index.sqlite", message: "m" } },
    },
    {
      name: "blob-reply",
      message: { id: 9, value: { bytes: new Uint8Array([9, 8, 7]), size: 3 } },
      id: 9,
    },
  ];
  return cases.map(({ name, message, id }) => ({
    name,
    frames: frames(message, id),
    message: JSON.parse(
      JSON.stringify(message, (_k, v: unknown) => (v instanceof Uint8Array ? hex(v) : v)),
    ),
  }));
}

/** Every vector file, by name under `native/history/vectors/`. */
export function historyVectors(): Record<string, unknown> {
  return { "wire.json": { toReader: toReader(), fromReader: fromReader() } };
}
