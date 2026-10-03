/** Small synthetic Pi tree. Mirrors documented persistence semantics, never imports Pi. */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { z } from "zod";
const Header = z.looseObject({
  type: z.literal("session"),
  id: z.string(),
  cwd: z.string(),
  version: z.number().optional(),
});
const Entry = z.looseObject({
  type: z.string(),
  id: z.string(),
  parentId: z.string().nullable(),
  message: z
    .looseObject({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
      ]),
    })
    .optional(),
});
type Entry = z.infer<typeof Entry>;
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-responses",
  provider: "openai",
  model: "synthetic",
  stopReason: "stop",
  timestamp: 0,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
export const fixtureEntries = [
  {
    type: "message",
    id: "root-user",
    parentId: null,
    message: { role: "user", content: "first question", timestamp: 0 },
  },
  {
    type: "message",
    id: "first-answer",
    parentId: "root-user",
    message: assistant("first answer"),
  },
  {
    type: "message",
    id: "second-user",
    parentId: "first-answer",
    message: { role: "user", content: "second question", timestamp: 0 },
  },
  {
    type: "message",
    id: "entry",
    parentId: "second-user",
    message: assistant("abandoned answer"),
  },
];
export function sessionFixture(cwd: string, id = "native", version?: number): string {
  return (
    [
      JSON.stringify({
        type: "session",
        id,
        cwd,
        timestamp: "2026-10-03T00:00:00.000Z",
        ...(version === undefined ? {} : { version }),
      }),
      ...fixtureEntries.map((entry) =>
        JSON.stringify({
          ...(version === undefined ? { type: entry.type, message: entry.message } : entry),
          timestamp: "2026-10-03T00:00:00.000Z",
        }),
      ),
    ].join("\n") + "\n"
  );
}
export class NativeHistory {
  path = "/synthetic/source.jsonl";
  id = "native";
  cwd = "";
  private entries = new Map<string, Entry>();
  private leaf: string | null = null;
  private seq = 0;
  entriesResponse() {
    return { entries: [...this.entries.values()], leafId: this.leaf };
  }
  load(path: string) {
    this.path = path;
    this.entries.clear();
    this.leaf = null;
    try {
      const lines = readFileSync(path, "utf8").trimEnd().split("\n"),
        header = Header.parse(JSON.parse(lines.shift() ?? ""));
      this.id = header.id;
      this.cwd = header.cwd;
      const legacyVersion = header.version === undefined || header.version === 1;
      let parent: string | null = null;
      for (const line of lines) {
        const value: unknown = JSON.parse(line);
        const legacy = z.record(z.string(), z.unknown()).parse(value);
        const entry = Entry.parse(
          legacyVersion
            ? { ...legacy, id: `legacy-${this.entries.size}`, parentId: parent }
            : value,
        );
        this.entries.set(entry.id, entry);
        this.leaf = entry.id;
        parent = entry.id;
      }
      if (legacyVersion)
        writeFileSync(
          path,
          [
            JSON.stringify({ ...header, version: 3 }),
            ...[...this.entries.values()].map((entry) => JSON.stringify(entry)),
          ].join("\n") + "\n",
        );
    } catch {
      this.id = "fresh-empty";
    }
  }
  private branch(): Entry[] {
    const branch: Entry[] = [];
    for (let id = this.leaf; id !== null;) {
      const entry = this.entries.get(id);
      if (!entry) throw new Error("Missing synthetic branch");
      branch.push(entry);
      id = entry.parentId;
    }
    return branch.toReversed();
  }
  context(): string {
    return this.branch()
      .flatMap((entry) => {
        const content = entry.message?.content;
        return content === undefined
          ? []
          : [
              typeof content === "string"
                ? content
                : content.map((block) => block.text ?? "").join(""),
            ];
      })
      .join("|");
  }
  navigate(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Missing synthetic entry");
    this.leaf = entry.message?.role === "user" ? entry.parentId : entry.id;
  }
  append(customType: string, data: unknown) {
    const entry = Entry.parse({
      type: "custom",
      id: `marker-${++this.seq}-${this.entries.size}`,
      parentId: this.leaf,
      customType,
      data,
      timestamp: "2026-10-03T00:00:00.000Z",
    });
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    this.entries.set(entry.id, entry);
    this.leaf = entry.id;
    return entry;
  }
  clone(target: string, entryId?: string, defer = false) {
    if (entryId) this.navigate(entryId);
    const branch = this.branch();
    if (defer || !branch.some((entry) => entry.message?.role === "assistant")) {
      this.path = target;
      this.id = "fork-native";
      this.entries = new Map(branch.map((entry) => [entry.id, entry]));
      return;
    }
    writeFileSync(
      target,
      [
        JSON.stringify({ type: "session", version: 3, id: "fork-native", cwd: this.cwd }),
        ...branch.map((entry) => JSON.stringify(entry)),
      ].join("\n") + "\n",
    );
    this.load(target);
  }
}
