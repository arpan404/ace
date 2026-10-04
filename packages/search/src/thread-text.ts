import type { Item } from "@ace/protocol";

export interface SearchTextSegment {
  name: string;
  category: string;
  text: string;
  source?: { streamId: string; bytes: number; encoding: "utf-16le" | "utf-8" } | undefined;
}
/** Only canonical typed text is indexed. Unknown/raw provider fields are excluded. */
export function* threadItemText(item: Item): Generator<SearchTextSegment> {
  if (item.type === "delegation.settled") {
    for (const [index, result] of item.results.entries())
      yield { name: `result:${index}`, category: "notices", text: result.result };
  } else if (item.type === "message") {
    for (const [index, part] of item.parts.entries()) {
      if (part.type === "text")
        yield { name: `part:${index}`, category: "messages", text: part.text, source: part.source };
      else if (part.type === "file")
        yield { name: `part:${index}`, category: "files", text: part.path };
    }
  } else if (item.type === "reasoning" || item.type === "notice") {
    yield {
      name: "text",
      category: item.type === "notice" && item.level === "error" ? "errors" : item.type,
      text: item.text,
      source: item.source,
    };
  } else if (item.type === "artifact") {
    yield { name: "path", category: "files", text: item.path };
  } else if (item.type === "tool_call") {
    yield { name: "title", category: "tool_output", text: item.call.title };
    if (item.call.status === "failed" && !item.call.error)
      yield { name: "failed", category: "errors", text: item.call.title };
    if (item.call.error) yield { name: "error", category: "errors", text: item.call.error };
    const detail = item.call.detail;
    if (detail.kind === "shell") {
      yield { name: "command", category: "commands", text: detail.command };
      if (detail.cwd) yield { name: "cwd", category: "files", text: detail.cwd };
      if (detail.output)
        yield {
          name: "output",
          category: "tool_output",
          text: detail.output.tail,
          source: { ...detail.output, encoding: "utf-8" },
        };
      if (detail.exitCode !== undefined && detail.exitCode !== null && detail.exitCode !== 0)
        yield {
          name: "exit",
          category: "errors",
          text: `Command failed with exit code ${detail.exitCode}: ${detail.command}`,
        };
    } else if ("changes" in detail) {
      for (const [index, change] of detail.changes.entries()) {
        for (const [field, value] of Object.entries(change))
          if (typeof value === "string")
            yield { name: `change:${index}:${field}`, category: "files", text: value };
      }
    } else {
      if ("path" in detail && detail.path)
        yield { name: "path", category: "files", text: detail.path };
      for (const field of ["query", "url", "description", "prompt", "message", "markdown"] as const)
        if (field in detail) {
          const value = Reflect.get(detail, field);
          if (typeof value === "string")
            yield { name: field, category: "tool_output", text: value };
        }
      if ("todos" in detail && detail.todos)
        for (const [index, todo] of detail.todos.entries())
          yield { name: `todo:${index}`, category: "tool_output", text: todo.content };
    }
  }
}
