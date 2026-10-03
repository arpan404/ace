/** Small synthetic Pi tree. Mirrors documented persistence semantics, never imports Pi. */
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { z } from "zod";
const Header = z.looseObject({ type: z.literal("session"), id: z.string(), cwd: z.string() });
const Entry = z.looseObject({
  type: z.string(),
  id: z.string(),
  parentId: z.string().nullable(),
  message: z.looseObject({ role: z.string(), content: z.string() }).optional(),
});
type Entry = z.infer<typeof Entry>;
export const fixtureEntries = [
  {
    type: "message",
    id: "root-user",
    parentId: null,
    message: { role: "user", content: "first question" },
  },
  {
    type: "message",
    id: "first-answer",
    parentId: "root-user",
    message: { role: "assistant", content: "first answer" },
  },
  {
    type: "message",
    id: "second-user",
    parentId: "first-answer",
    message: { role: "user", content: "second question" },
  },
  {
    type: "message",
    id: "entry",
    parentId: "second-user",
    message: { role: "assistant", content: "abandoned answer" },
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
        JSON.stringify({ ...entry, timestamp: "2026-10-03T00:00:00.000Z" }),
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
  load(path: string) {
    this.path = path;
    this.entries.clear();
    this.leaf = null;
    try {
      const lines = readFileSync(path, "utf8").trimEnd().split("\n"),
        header = Header.parse(JSON.parse(lines.shift() ?? ""));
      this.id = header.id;
      this.cwd = header.cwd;
      for (const line of lines) {
        const entry = Entry.parse(JSON.parse(line));
        this.entries.set(entry.id, entry);
        this.leaf = entry.id;
      }
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
      .flatMap((entry) => (entry.message ? [entry.message.content] : []))
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
  clone(target: string, entryId?: string) {
    if (entryId) this.navigate(entryId);
    const branch = this.branch();
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
