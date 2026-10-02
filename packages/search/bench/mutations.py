"""Non-gating mutation experiment; restores each file even when the run fails."""
from pathlib import Path
import json
import os
import subprocess

root = Path(__file__).resolve().parents[3]
mutations = [
    ("skip item ingestion", "writer.ts", 'const { title, window } = itemText(p.item, output);', 'return;\n      const { title, window } = itemText(p.item, output);', "append, authoritative update"),
    ("retain obsolete FTS postings", "writer.ts", 'if (old) this.removePostings(Document.parse(old));', 'if (old) {}', "append, authoritative update"),
    ("ignore item deletion", "writer.ts", 'else if (p.type === "item.deleted") this.deleteItem(event.threadId, p.itemId);', 'else if (p.type === "item.deleted") return;', "append, authoritative update"),
    ("index every stream delta", "index.ts", 'this.writer.flush("dirty=1 AND complete=1", 256);', 'this.writer.flush("dirty=1", 256);', "stream deltas write"),
    ("drop capped output tail", "text.ts", 'return window.head + GAP + window.tail;', 'return window.head;', "huge completed and streamed"),
    ("ignore query filters", "query.ts", 'if (value !== undefined) {', 'if (false) {', "workspace, provider, date"),
    ("remove title rank weight", "query.ts", 'bm25(${table},8.0,1.0)', 'bm25(${table},0.0,1.0)', "title matches rank above"),
    ("accept stale pagination", "query.ts", 'if (cursor.generation !== generation) throw new Error("search_cursor_stale");', 'if (false) throw new Error("search_cursor_stale");', "pagination keeps tied"),
    ("broaden token queries with OR", "text.ts", '.join(" AND ");', '.join(" OR ");', "FTS operators and SQL"),
    ("lose durable high-water mark", "index.ts", '"UPDATE search_meta SET seq=? WHERE id=1", throughSeq', '"UPDATE search_meta SET seq=? WHERE id=1", 0', "backfill yields in bounded"),
    ("starve dirty documents by row id", "writer.ts", 'ORDER BY dirty_since,id LIMIT ?', 'ORDER BY id LIMIT ?', "continuously dirty"),
    ("replace stored output heads with summary tails", "output.ts", 'if (!reader || !summary.bytes) return summary.tail;', 'return summary.tail;', "huge completed and streamed"),
    ("fail to decrement durable pending count", "schema.ts", 'pending=pending+NEW.dirty-OLD.dirty', 'pending=pending', "backfill yields in bounded"),
]
results = []
for name, filename, before, after, behavior in mutations:
    path = root / "packages/search/src" / filename
    original = path.read_text()
    if original.count(before) != 1:
        raise RuntimeError(f"Mutation target changed: {name}")
    try:
        path.write_text(original.replace(before, after))
        result = subprocess.run(
            ["bun", "run", "test", "packages/search/src/search.test.ts", "-t", behavior],
            cwd=root, capture_output=True, text=True,
            env={**os.environ, "VITEST_MAX_WORKERS": "2"},
        )
        killed = result.returncode != 0 and "FAIL" in result.stdout + result.stderr
        results.append({"mutation": name, "test": behavior, "killed": killed})
        print(f"{name}: {'killed' if killed else 'SURVIVED'}", flush=True)
        if not killed:
            raise RuntimeError(result.stdout + result.stderr)
    finally:
        path.write_text(original)
(root / "packages/search/bench/mutations.json").write_text(json.dumps(results, indent=2) + "\n")
