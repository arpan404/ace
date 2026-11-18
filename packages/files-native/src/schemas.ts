import { z } from "zod";

/**
 * The JSON shapes `files-wire` defines (`native/files/crates/files-wire`). Every nested value is
 * tagged, optional fields are absent rather than null, and the field order here matches the Rust
 * structs so encoding a parsed message reproduces the golden vectors byte for byte.
 */

const u64 = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** What a path is; a symlink names its target's kind when the target stays inside the root. */
export type FileKind =
  | { type: "file" }
  | { type: "directory" }
  | { type: "other" }
  | { type: "symlink"; target?: FileKind | undefined };

// Built once at module level; only the symlink's target loops back, through a bare reference.
export const fileKindSchema: z.ZodType<FileKind> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file") }),
  z.object({ type: z.literal("directory") }),
  z.object({ type: z.literal("other") }),
  z.object({ type: z.literal("symlink"), target: z.lazy(() => fileKindSchema).optional() }),
]);

/** One entry of a listed folder. */
export const entrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: fileKindSchema,
  size: u64,
  mtimeMs: z.number().int(),
  ignored: z.boolean(),
});

/** One page of a folder listing. */
export const pageSchema = z.object({
  entries: z.array(entrySchema),
  nextCursor: z.string().optional(),
  total: u64,
});

/** The metadata of a `read`; the bytes follow in a body frame when `body` is true. */
export const readMetaSchema = z.object({
  size: u64,
  version: z.string(),
  binary: z.boolean(),
  encoding: z.string(),
  bom: z.boolean(),
  eof: z.boolean(),
  body: z.boolean(),
});

/** How a search compares case. */
export const caseSchema = z.enum(["sensitive", "insensitive", "smart"]);

/** What a `search` request looks for; its fields are spread beside `root` in the request. */
export const searchQuerySchema = z.object({
  pattern: z.string(),
  regex: z.boolean(),
  case: caseSchema,
  wholeWord: z.boolean(),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  includeIgnored: z.boolean(),
  maxMatches: u64,
  maxFileBytes: u64,
});

/** One matching line: a 1-based line number, a bounded preview and byte ranges inside it. */
export const lineMatchSchema = z.object({
  line: u64,
  preview: z.string(),
  ranges: z.array(z.tuple([u64, u64])),
});

/** The matching lines of one file. */
export const fileMatchesSchema = z.object({
  path: z.string(),
  lines: z.array(lineMatchSchema),
});

/** How a finished search went. */
export const summarySchema = z.object({
  files: u64,
  bytes: u64,
  matches: u64,
  limitHit: z.boolean(),
});

/** One quick-open result. */
export const hitSchema = z.object({
  path: z.string(),
  score: u64,
  positions: z.array(u64),
});

/** The answer to an `indexQuery`. */
export const indexResultSchema = z.object({
  hits: z.array(hitSchema),
  total: u64,
  truncated: z.boolean(),
  ready: z.boolean(),
});

/**
 * One path's details: the version a guarded write compares (`tree:` plus a digest for a folder),
 * the entry's own size, its kind and its permission bits.
 */
export const descriptionSchema = z.object({
  version: z.string(),
  ownVersion: z.string().optional(),
  shallow: z.boolean(),
  size: u64,
  kind: fileKindSchema,
  mode: u64,
});

/** What a `request` asks ace-files to do; `root` is the number `openRoot` handed out. */
export const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("openRoot"), path: z.string() }),
  z.object({ op: z.literal("closeRoot"), root: u64 }),
  z.object({
    op: z.literal("list"),
    root: u64,
    dir: z.string(),
    limit: u64,
    cursor: z.string().optional(),
    hide: z.array(z.string()),
  }),
  z.object({ op: z.literal("stat"), root: u64, path: z.string() }),
  z.object({
    op: z.literal("describe"),
    root: u64,
    path: z.string(),
    full: z.boolean().optional(),
  }),
  z.object({ op: z.literal("describeEntry"), root: u64, path: z.string() }),
  z.object({ op: z.literal("measure"), root: u64, path: z.string() }),
  z.object({
    op: z.literal("read"),
    root: u64,
    path: z.string(),
    offset: u64,
    length: u64,
    maxSize: u64.optional(),
  }),
  z.object({
    op: z.literal("write"),
    root: u64,
    path: z.string(),
    expected: z.string().optional(),
  }),
  z.object({ op: z.literal("createFile"), root: u64, path: z.string() }),
  z.object({ op: z.literal("createDir"), root: u64, path: z.string() }),
  z.object({
    op: z.literal("rename"),
    root: u64,
    from: z.string(),
    to: z.string(),
    expected: z.string().optional(),
    own: z.string().optional(),
  }),
  z.object({ op: z.literal("remove"), root: u64, path: z.string() }),
  z.object({
    op: z.literal("trash"),
    root: u64,
    path: z.string(),
    endpoint: z.string(),
    expected: z.string(),
    own: z.string().optional(),
  }),
  z.object({
    op: z.literal("untrash"),
    root: u64,
    endpoint: z.string(),
    path: z.string(),
  }),
  z.object({ op: z.literal("watch"), root: u64 }),
  z.object({ op: z.literal("unwatch"), subscription: u64 }),
  z.object({ op: z.literal("indexQuery"), root: u64, query: z.string(), limit: u64 }),
  z.object({ op: z.literal("search"), root: u64 }).extend(searchQuerySchema.shape),
]);

/** What a successful request produced; the tag says which op it answers. */
export const replySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("root"), root: u64 }),
  z.object({ type: z.literal("subscription"), subscription: u64 }),
  z.object({ type: z.literal("page"), ...pageSchema.shape }),
  z.object({ type: z.literal("entry"), ...entrySchema.shape }),
  z.object({ type: z.literal("description"), ...descriptionSchema.shape }),
  z.object({ type: z.literal("measure"), bytes: u64, shallow: z.boolean() }),
  z.object({ type: z.literal("read"), ...readMetaSchema.shape }),
  z.object({ type: z.literal("version"), version: z.string() }),
  z.object({ type: z.literal("index"), ...indexResultSchema.shape }),
]);

/** What happened to a watched path. */
export const changeKindSchema = z.enum(["created", "modified", "deleted"]);

/** One path a watcher saw change. */
export const changeSchema = z.object({
  path: z.string(),
  kind: changeKindSchema,
  directory: z.boolean(),
});

/** An `event` message's payload. */
export const eventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changes"), changes: z.array(changeSchema) }),
  z.object({ type: z.literal("rescan"), dir: z.string().optional() }),
  z.object({ type: z.literal("warning"), message: z.string() }),
  z.object({ type: z.literal("matches"), file: fileMatchesSchema }),
  z.object({ type: z.literal("searchFailed"), code: z.string(), message: z.string() }),
  z.object({ type: z.literal("searchDone"), summary: summarySchema }),
]);

/** One JSON message in either direction. */
export const messageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocol: u64,
    version: z.string().optional(),
  }),
  z.object({ type: z.literal("request"), id: u64, op: opSchema }),
  z.object({ type: z.literal("cancel"), id: u64 }),
  z.object({ type: z.literal("response"), id: u64, result: replySchema }),
  z.object({
    type: z.literal("error"),
    id: u64,
    code: z.string(),
    message: z.string(),
    current: z.string().optional(),
  }),
  z.object({ type: z.literal("event"), subscription: u64, payload: eventPayloadSchema }),
]);

export type Entry = z.infer<typeof entrySchema>;
export type Description = z.infer<typeof descriptionSchema>;
export type Page = z.infer<typeof pageSchema>;
export type ReadMeta = z.infer<typeof readMetaSchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type LineMatch = z.infer<typeof lineMatchSchema>;
export type FileMatches = z.infer<typeof fileMatchesSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type Hit = z.infer<typeof hitSchema>;
export type IndexResult = z.infer<typeof indexResultSchema>;
export type Op = z.infer<typeof opSchema>;
export type Reply = z.infer<typeof replySchema>;
export type ChangeKind = z.infer<typeof changeKindSchema>;
export type Change = z.infer<typeof changeSchema>;
export type EventPayload = z.infer<typeof eventPayloadSchema>;
export type Message = z.infer<typeof messageSchema>;
