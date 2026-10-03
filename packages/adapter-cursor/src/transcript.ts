import type { Fact, Key } from "@ace/core";
/** Order identity, never text equality. Only the SDK delta channel owns live content. */
export class Transcript {
  private positions = new Map<
    Key,
    { order: number; text?: Key; thinking?: Key; field?: "text" | "thinking" }
  >();
  private prefix: string;
  private limit: number;
  constructor(prefix: string, limit: number) {
    this.prefix = prefix;
    this.limit = limit;
  }
  append(agent: Key, field: "text" | "thinking", text: string): Fact[] {
    if (!text) return [];
    let position = this.positions.get(agent);
    if (!position) {
      if (this.positions.size >= this.limit)
        throw new Error("SDK transcript identity budget exceeded");
      position = { order: 0 };
      this.positions.set(agent, position);
    }
    const facts: Fact[] = [];
    if (position.field !== field || !position[field]) {
      facts.push(...this.boundary(agent));
      const item = `${this.prefix}:${agent}:${field}:${++position.order}`;
      position[field] = item;
      position.field = field;
      facts.push({
        type: "item.upsert",
        agent,
        item,
        draft:
          field === "text"
            ? { type: "message", role: "assistant", parts: [], complete: false }
            : { type: "reasoning", text: "", complete: false },
      });
    }
    const item = position[field];
    if (item)
      facts.push({
        type: "item.delta",
        agent,
        item,
        field: field === "text" ? "text" : "reasoning",
        append: text,
      });
    return facts;
  }
  boundary(agent: Key): Fact[] {
    const position = this.positions.get(agent);
    if (!position) return [];
    const item = position.field ? position[position.field] : undefined;
    const type = position.field === "thinking" ? "reasoning" : "message";
    delete position.field;
    delete position.text;
    delete position.thinking;
    return item ? [{ type: "item.upsert", agent, item, draft: { type, complete: true } }] : [];
  }
  end(): Fact[] {
    const facts: Fact[] = [];
    for (const agent of this.positions.keys()) facts.push(...this.boundary(agent));
    return facts;
  }
}
