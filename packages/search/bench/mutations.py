"""Opt-in merge-time mutation experiment; never part of local static validation."""
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
    ("remove title rank weight", "query.ts", 'bm25(${table},8.0,1.0)', 'bm25(${table},1.0,1.0)', "title matches rank above"),
    ("accept stale pagination", "query.ts", 'if (cursor.generation !== generation) throw new Error("search_cursor_stale");', 'if (false) throw new Error("search_cursor_stale");', "pagination keeps tied"),
    ("broaden token queries with OR", "text.ts", '.join(" AND ");', '.join(" OR ");', "FTS operators and SQL"),
    ("lose durable high-water mark", "index.ts", '"UPDATE search_meta SET seq=? WHERE id=1", throughSeq', '"UPDATE search_meta SET seq=? WHERE id=1", 0', "backfill yields in bounded"),
    ("starve dirty documents by row id", "writer.ts", 'ORDER BY dirty_since,id LIMIT ?', 'ORDER BY id LIMIT ?', "continuously dirty"),
    ("replace stored output heads with summary tails", "output.ts", 'if (!reader || !summary.bytes) return summary.tail;', 'return summary.tail;', "huge completed and streamed"),
    ("fail to decrement durable pending count", "schema.ts", 'pending=pending+NEW.dirty-OLD.dirty', 'pending=pending', "backfill yields in bounded"),
    ("share palette admission with transcripts", "query-service.ts", 'parsed.data.scope === "threads" ? this.titles : this.transcripts', 'this.transcripts', "palette requests remain available"),
    ("lose split Unicode during staging", "encoding.ts", 'return value.isWellFormed() ? "t" + value : "j" + JSON.stringify(value);', 'return "t" + value;', "a Unicode character split"),
    ("collapse a trimmed Unicode tail to its last characters", "text.ts", 'window.size <= FIELD_CAP * 2 && window.head.length + window.tail.length >= window.size', 'window.size <= FIELD_CAP * 2', "trimming a character across both caps"),
    ("join attachment paths with streamed text", "text.ts", 'if (window.size && item.parts.at(-1)?.type !== "text") window = appendWindow(window, "\\n");', 'if (false) window = appendWindow(window, "\\n");', "text streamed after an attachment"),
]
mutations.extend([
    ('commit staging when an append batch fails', 'index.ts', 'this.db.exec("ROLLBACK TO search_batch; RELEASE search_batch");', 'this.db.exec("RELEASE search_batch");', 'a failed standalone append'),
    ('bypass search query read authorization', 'apps/daemon/src/server.ts', 'case "search.query":\n          if (!allows(authenticated.get(socket), "read")) {', 'case "search.query":\n          if (false) {', 'search over pinned WSS'),
    ('bypass search status read authorization', 'apps/daemon/src/server.ts', 'case "search.status":\n          if (!allows(authenticated.get(socket), "read")) {', 'case "search.status":\n          if (false) {', 'search over pinned WSS'),
    ('ignore thread retention', 'index.ts', 'deleteThread(threadId: string): void {\n    this.atomic(() => {', 'deleteThread(threadId: string): void {\n    return;\n    this.atomic(() => {', 'thread retention removes transcript'),
    ('skip rebuild recovery', 'index.ts', 'await this.backfill(source, options);', 'return;', 'rebuild repairs lost FTS postings'),
    ('ignore cursor fingerprint', 'query.ts', 'if (cursor.fingerprint !== fingerprint) throw new Error("search_invalid_query");', 'if (false) throw new Error("search_invalid_query");', 'pagination keeps tied'),
    ('erase highlight offsets', 'query.ts', 'return { text, highlights };', 'return { text, highlights: [] };', 'Unicode, diacritics, CJK substrings'),
    ('accept older metadata at thread creation', 'writer.ts', 'WHERE search_threads.seq<excluded.seq', 'WHERE search_threads.seq<>excluded.seq', 'partial backfill publishes only'),
    ('accept older metadata at thread update', 'writer.ts', 'WHERE id=? AND seq<?', 'WHERE id=? AND seq<>?', 'current thread metadata wins'),
    ('stage the historical creation title', 'writer.ts', 'this.currentTitle(event.threadId),', 'capText(t.title),', 'partial backfill publishes only'),
    ('stage the historical update title', 'writer.ts', 'if (p.title !== undefined) this.stageTitle(event.threadId, event.seq);', 'if (p.title !== undefined) this.sql.run("UPDATE search_stage SET title=?,dirty=1 WHERE thread=? AND item=\'\'", capText(p.title), event.threadId);', 'partial backfill publishes only'),
    ('split a thread title at its response cap', 'query.ts', 'threadTitle: truncateText(row.threadTitle, 1024),', 'threadTitle: row.threadTitle.slice(0, 1024),', 'thread titles and snippets stop'),
    ('split a snippet at its response cap', 'query.ts', 'for (const char of marked) {', 'for (const char of marked.split("")) {', 'thread titles and snippets stop'),
    ('resolve close before worker termination', 'query-service.ts', 'void this.stopping.then(', 'void Promise.resolve().then(', 'closing waits for both reader workers'),
])
def test_file(name, filename):
    if filename.startswith("apps/"):
        return "apps/daemon/src/search.remote.test.ts"
    if name in {"commit staging when an append batch fails", "accept older metadata at thread creation", "stage the historical creation title", "stage the historical update title", "split a thread title at its response cap", "split a snippet at its response cap"}:
        return "packages/search/src/review-regressions.test.ts"
    if name == "resolve close before worker termination":
        return "packages/search/src/worker-lifecycle.test.ts"
    if filename == "query-service.ts":
        return "packages/search/src/query-service.test.ts"
    if filename == "encoding.ts" or name in {"collapse a trimmed Unicode tail to its last characters", "join attachment paths with streamed text"}:
        return "packages/search/src/outputs.test.ts"
    return "packages/search/src/search.test.ts"

selection = os.environ.get("MUTATION_MATCH", "")
results_path = root / "packages/search/bench/mutations.json"
results = json.loads(results_path.read_text()) if selection else []
for name, filename, before, after, behavior in mutations:
    if selection and selection not in name:
        continue
    path = root / filename if "/" in filename else root / "packages/search/src" / filename
    original = path.read_text()
    if original.count(before) != 1:
        raise RuntimeError(f"Mutation target changed: {name}")
    try:
        path.write_text(original.replace(before, after))
        result = subprocess.run(
            ["bun", "run", "test", test_file(name, filename), "-t", behavior],
            cwd=root, capture_output=True, text=True,
            env={**os.environ, "VITEST_MAX_WORKERS": "2"},
        )
        killed = result.returncode != 0 and "FAIL" in result.stdout + result.stderr
        results = [entry for entry in results if entry["mutation"] != name]
        results.append({"mutation": name, "test": behavior, "killed": killed})
        print(f"{name}: {'killed' if killed else 'SURVIVED'}", flush=True)
        if not killed:
            raise RuntimeError(result.stdout + result.stderr)
    finally:
        path.write_text(original)
results_path.write_text(json.dumps(results, indent=2) + "\n")
