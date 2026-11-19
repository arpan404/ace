#!/usr/bin/env bash
# Extracts the tool calls of real coding-agent sessions from an ace home, for measuring Spade's
# classifier only (ADR 0172, amendment 1). Never train the shipped weights on them, never commit
# the output or anything derived from single calls: report aggregate numbers only.
#
#   real-sessions.sh ~/.ace /var/tmp/spade-real
#
# It never starts a daemon (one started on a copy of a real home resumes live agents). It takes a
# consistent copy of `events.sqlite` from a read-only connection (`VACUUM INTO`, one read
# transaction, so a live daemon's writes don't restart it), then reads only that copy.
set -euo pipefail

home="${1:?usage: real-sessions.sh ACE_HOME OUT_DIR}"
out="${2:?usage: real-sessions.sh ACE_HOME OUT_DIR}"
case "$out" in
  "$home"*) echo "the output must be outside the ace home" >&2; exit 2 ;;
esac
umask 077
mkdir -p "$out"
copy="$out/events.sqlite"
rm -f "$copy"
sqlite3 "file:$home/events.sqlite?mode=ro" "VACUUM INTO '$copy'"
chmod 400 "$copy"

sqlite3 -readonly "file:$copy?mode=ro&immutable=1" <<'SQL' > "$out/calls.jsonl"
.mode list
SELECT json_object(
  'thread', i.thread_id,
  'seq', i.created_seq,
  'provider', COALESCE(t.provider, ''),
  'workspace', COALESCE(w.path, ''),
  'kind', COALESCE(json_extract(i.item, '$.call.kind'), ''),
  'title', COALESCE(json_extract(i.item, '$.call.title'), ''),
  'command', json_extract(i.item, '$.call.detail.command'),
  'server', json_extract(i.item, '$.call.detail.server'),
  'tool', json_extract(i.item, '$.call.detail.tool'),
  'arguments', json(COALESCE(json_extract(i.item, '$.call.detail.arguments'), 'null')),
  'path', COALESCE(
    json_extract(i.item, '$.call.detail.path'),
    json_extract(i.item, '$.call.detail.changes[0].path')
  )
)
FROM items i
JOIN threads t ON t.id = i.thread_id
LEFT JOIN workspaces w ON w.id = t.workspace_id
WHERE json_extract(i.item, '$.type') = 'tool_call'
ORDER BY i.thread_id, i.created_seq;
SQL
chmod 400 "$out/calls.jsonl"
echo "$(wc -l < "$out/calls.jsonl") calls in $out/calls.jsonl"
