const ACE_PROPOSED_PLAN_MARKER_LINE_REGEX =
  /^\s*<!--\s*ACE_PROPOSED_PLAN_(?:START|END)(?:\s*--\s*>?)?\s*$/gim;
const COMPACT_PLAN_WORDS = new Map(
  [
    "ace",
    "active",
    "add",
    "against",
    "after",
    "alerts",
    "allow",
    "already",
    "and",
    "app",
    "apps",
    "architecture",
    "around",
    "at",
    "audit",
    "autoscaling",
    "available",
    "backed",
    "backlog",
    "backoff",
    "baselines",
    "bottlenecks",
    "breaker",
    "burst",
    "caches",
    "can",
    "cascading",
    "checks",
    "circuit",
    "client",
    "clients",
    "codex",
    "collect",
    "common",
    "communications",
    "compatible",
    "concurrency",
    "connections",
    "containerization",
    "containerize",
    "cpu",
    "crash",
    "current",
    "dashboards",
    "db",
    "dbs",
    "deduplication",
    "define",
    "delivery",
    "dependencies",
    "deployment",
    "deterministic",
    "domain",
    "dropped",
    "durable",
    "e",
    "ephemeral",
    "event",
    "events",
    "external",
    "failure",
    "failures",
    "file",
    "for",
    "g",
    "gather",
    "graceful",
    "harden",
    "handlers",
    "health",
    "heartbeat",
    "high",
    "horizontally",
    "idempotent",
    "if",
    "implement",
    "implementation",
    "improve",
    "incident",
    "integrate",
    "inventory",
    "is",
    "jitter",
    "journal",
    "json",
    "kafka",
    "latency",
    "layer",
    "least",
    "lifecycle",
    "lightweight",
    "limit",
    "limits",
    "load",
    "logging",
    "logic",
    "logs",
    "long",
    "losing",
    "make",
    "map",
    "memory",
    "messages",
    "metadata",
    "metrics",
    "minimal",
    "model",
    "monitoring",
    "months",
    "move",
    "multi",
    "noisy",
    "observability",
    "once",
    "open",
    "optimize",
    "or",
    "orchestration",
    "packages",
    "per",
    "persistence",
    "persist",
    "persistent",
    "ping",
    "plan",
    "policies",
    "possible",
    "prepare",
    "proactive",
    "probes",
    "process",
    "processes",
    "processing",
    "profile",
    "prometheus",
    "protect",
    "provider",
    "readiness",
    "reattachments",
    "reconnect",
    "reconnection",
    "record",
    "redis",
    "reliability",
    "request",
    "resource",
    "restart",
    "restarting",
    "resilient",
    "resume",
    "retry",
    "review",
    "robust",
    "robustness",
    "run",
    "running",
    "runtime",
    "safe",
    "scalability",
    "scale",
    "scenarios",
    "semantics",
    "server",
    "services",
    "session",
    "sessions",
    "shutdown",
    "signals",
    "slow",
    "slo",
    "slos",
    "spike",
    "startup",
    "state",
    "stateless",
    "sticky",
    "stop",
    "store",
    "stores",
    "strategies",
    "streams",
    "structured",
    "supervision",
    "support",
    "table",
    "the",
    "throughput",
    "timeouts",
    "to",
    "tokens",
    "traffic",
    "turns",
    "unavailable",
    "usage",
    "use",
    "via",
    "web",
    "websocket",
    "when",
    "where",
    "with",
    "without",
  ].map((word) => [word, word]),
);

const COMPACT_PLAN_WORD_MAX_LENGTH = Math.max(
  ...Array.from(COMPACT_PLAN_WORDS.keys(), (word) => word.length),
);

function normalizeProposedPlanMarkdownForDisplay(planMarkdown: string): string {
  return repairCompactPiPlanMarkdown(
    planMarkdown
    .replace(ACE_PROPOSED_PLAN_MARKER_LINE_REGEX, "")
    .replace(/^>\s*(#{1,6})/gm, "$1")
    .replace(/^(#{1,6})(?=[^\s#])/gm, "$1 ")
    .replace(/(?<!\d)(\d+)\.(?=\S)/g, "$1. ")
      .replace(/([,:;])(?=\S)/g, "$1 "),
  ).trim();
}

export function proposedPlanTitle(planMarkdown: string): string | null {
  const displayMarkdown = normalizeProposedPlanMarkdownForDisplay(planMarkdown);
  const heading = displayMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const normalizedMarkdown = normalizeProposedPlanMarkdownForDisplay(planMarkdown);
  const lines = normalizedMarkdown.trimEnd().split(/\r?\n/);
  const sourceLines =
    lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) && lines.slice(1).some(hasVisiblePlanLine)
      ? lines.slice(1)
      : [...lines];
  while (sourceLines[0]?.trim().length === 0) {
    sourceLines.shift();
  }
  const firstHeadingMatch = sourceLines[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (firstHeadingMatch?.[1]?.trim().toLowerCase() === "summary") {
    sourceLines.shift();
    while (sourceLines[0]?.trim().length === 0) {
      sourceLines.shift();
    }
  }
  return sourceLines.join("\n");
}

function hasVisiblePlanLine(line: string): boolean {
  return line.trim().length > 0;
}

function repairCompactPiPlanMarkdown(markdown: string): string {
  return markdown
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[A-Za-z]{10,}/g, repairCompactAlphaRun)
    .replace(/\b(Proposed|Implementation)\s+Plan\s*:/i, "# $1 Plan:")
    .replace(/\b([A-Za-z)][A-Za-z)\]]*)\s*(\d+)\.\s+/g, "$1\n\n$2. ")
    .replace(/([.)])\s*[-–]\s*(?=[A-Z])/g, "$1\n   - ")
    .replace(/([a-z])[-–]\s*(?=[A-Z])/g, "$1\n   - ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function repairCompactAlphaRun(run: string): string {
  const lowerRun = run.toLowerCase();
  const segmented = segmentCompactPlanWord(lowerRun);
  if (!segmented || segmented.length < 2) {
    return run;
  }

  let cursor = 0;
  return segmented
    .map((word) => {
      const source = run.slice(cursor, cursor + word.length);
      cursor += word.length;
      if (source.toUpperCase() === source) {
        return word.toUpperCase();
      }
      if (source[0] && source[0].toUpperCase() === source[0]) {
        return `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`;
      }
      return word;
    })
    .join(" ")
    .replace(/\bDb(s?)\b/g, "DB$1")
    .replace(/\bCpu\b/g, "CPU")
    .replace(/\bJson\b/g, "JSON")
    .replace(/\bSlo(s?)\b/g, "SLO$1")
    .replace(/\bWeb socket\b/gi, "WebSocket")
    .replace(/\bCodex app\b/gi, "codex app");
}

function segmentCompactPlanWord(value: string): string[] | null {
  const memo = new Map<number, string[] | null>();
  const segmentFrom = (index: number): string[] | null => {
    if (index >= value.length) {
      return [];
    }
    if (memo.has(index)) {
      return memo.get(index) ?? null;
    }

    let best: string[] | null = null;
    const maxEnd = Math.min(value.length, index + COMPACT_PLAN_WORD_MAX_LENGTH);
    for (let end = maxEnd; end > index; end -= 1) {
      const candidate = value.slice(index, end);
      const word = COMPACT_PLAN_WORDS.get(candidate);
      if (!word) {
        continue;
      }
      const tail = segmentFrom(end);
      if (!tail) {
        continue;
      }
      best = [word, ...tail];
      break;
    }

    memo.set(index, best);
    return best;
  };

  return segmentFrom(0);
}

export function buildCollapsedProposedPlanPreviewMarkdown(
  planMarkdown: string,
  options?: {
    maxLines?: number;
  },
): string {
  const maxLines = options?.maxLines ?? 8;
  const lines = stripDisplayedPlanMarkdown(planMarkdown)
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const previewLines: string[] = [];
  let visibleLineCount = 0;
  let hasMoreContent = false;

  for (const line of lines) {
    const isVisibleLine = line.trim().length > 0;
    if (isVisibleLine && visibleLineCount >= maxLines) {
      hasMoreContent = true;
      break;
    }
    previewLines.push(line);
    if (isVisibleLine) {
      visibleLineCount += 1;
    }
  }

  while (previewLines.length > 0 && previewLines.at(-1)?.trim().length === 0) {
    previewLines.pop();
  }

  if (previewLines.length === 0) {
    return proposedPlanTitle(planMarkdown) ?? "Plan preview unavailable.";
  }

  if (hasMoreContent) {
    previewLines.push("", "...");
  }

  return previewLines.join("\n");
}

function sanitizePlanFileSegment(input: string): string {
  const sanitized = input
    .toLowerCase()
    .replace(/[`'".,!?()[\]{}]+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "plan";
}

export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown.trim()}`;
}

export function resolvePlanFollowUpSubmission(input: { draftText: string; planMarkdown: string }): {
  text: string;
  interactionMode: "default" | "plan";
} {
  const trimmedDraftText = input.draftText.trim();
  if (trimmedDraftText.length > 0) {
    return {
      text: trimmedDraftText,
      interactionMode: "plan",
    };
  }

  return {
    text: buildPlanImplementationPrompt(input.planMarkdown),
    interactionMode: "default",
  };
}

export function buildPlanImplementationThreadTitle(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  if (!title) {
    return "Implement plan";
  }
  return `Implement ${title}`;
}

export function buildProposedPlanMarkdownFilename(planMarkdown: string): string {
  const title = proposedPlanTitle(planMarkdown);
  return `${sanitizePlanFileSegment(title ?? "plan")}.md`;
}

export function normalizePlanMarkdownForExport(planMarkdown: string): string {
  return `${planMarkdown.trimEnd()}\n`;
}

export function downloadPlanAsTextFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}
