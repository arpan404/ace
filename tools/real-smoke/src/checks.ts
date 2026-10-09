export interface PageFacts {
  text: string;
  titles: string[];
  bubbles: string[];
  models: string[];
  alerts: string[];
  icons: { name: string; brand: boolean }[];
  thread?: {
    title: string;
    sent: boolean;
    current: string;
    latest: string;
    queued: { text: string; state: string }[];
  };
  catalogsReady: boolean;
  expected: { models?: boolean; skills?: boolean; sessions?: boolean };
}
export interface Finding {
  code: string;
  message: string;
}
const patterns: readonly [string, RegExp][] = [
  [
    "wrapper-tag",
    /<\/?(?:recommended_plugins|system|instructions|environment_context|[a-z]+_[a-z_]+)\b[^>]*>/i,
  ],
  // oxlint-disable-next-line eslint/no-control-regex -- ANSI is a presentation failure.
  ["ansi-escape", /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*\u0007)/],
  ["omitted-object", /UNPREPARED OBJECT OMITTED/],
  ["raw-event-prefix", /(?:^|\n)\s*[a-z_]+\.[a-z_]+:\s/],
  ["local-hostname", /\b[a-z\d][a-z\d.-]*\.local\b/i],
  ["bare-unavailable", /(?:^|\n)\s*Unavailable\s*(?:\n|$)/],
];
/** Only inspect display labels for ids, and prose message bubbles for serialized payloads. */
export function checkPage(facts: PageFacts): Finding[] {
  const failures: Finding[] = [];
  const add = (code: string, message: string) => failures.push({ code, message });
  for (const [code, regex] of patterns)
    if (regex.test([facts.text, ...facts.titles].join("\n")))
      add(code, "Raw presentation data is visible");
  for (const text of facts.bubbles)
    if (/^\s*[[{][\s\S]*"[\w.-]+"\s*:[\s\S]*[\]}]\s*$/.test(text))
      add("json-bubble", "A message bubble displays a serialized object");
  if (
    facts.models.some((label) =>
      /(?:^|\s)(?:[a-z\d]+\/)?[a-z][a-z\d]*(?:-[a-z\d.]+)+(?:$|\s)/.test(label),
    )
  )
    add("raw-model-id", "A model display label contains a raw id");
  if (
    /Something went wrong/i.test(facts.text) ||
    facts.alerts.some((text) =>
      /error|failed|couldn't|cannot|can't|went wrong|unavailable|rejected/i.test(text),
    )
  )
    add("error-surface", "An error toast or banner is visible");
  for (const icon of facts.icons)
    if (!icon.brand) add("provider-icon", `The ${icon.name} icon has no brand mark`);
  const thread = facts.thread;
  if (thread) {
    if (thread.sent && /^New thread$/i.test(thread.title))
      add("untitled-sent-thread", "A sent thread is titled New thread");
    if (/\bWorking\b/.test(thread.current) && /\b(?:Not sent|Stopped)\b/i.test(thread.latest))
      add("contradictory-state", "The latest turn is Working and Not sent or Stopped");
    const states = new Map<string, Set<string>>();
    for (const queued of thread.queued) {
      const seen = states.get(queued.text) ?? new Set();
      seen.add(queued.state);
      states.set(queued.text, seen);
    }
    if ([...states.values()].some((seen) => seen.has("queued") && seen.has("uncertain")))
      add("contradictory-queue", "The same text is Queued and May have been sent");
  }
  if (facts.catalogsReady) {
    if (
      facts.expected.models &&
      /No models available|Loading models|No models on this account/.test(facts.text)
    )
      add("empty-models", "Model choices remain empty after the catalog is ready");
    if (facts.expected.skills && /No skills|Loading skills|No commands|No results/.test(facts.text))
      add("empty-skills", "Skills remain empty after the catalog is ready");
    if (facts.expected.sessions && /No matching sessions|Loading past sessions/.test(facts.text))
      add("empty-sessions", "Past sessions remain empty after the scan is ready");
  }
  return failures;
}
export function checkLog(entry: {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}): Finding[] {
  if (!["warn", "error"].includes(entry.level)) return [];
  if (
    entry.level === "warn" &&
    entry.fields?.code === "no_models" &&
    /copilot/i.test(String(entry.fields.source ?? entry.fields.sourceLabel ?? ""))
  )
    return [];
  return [{ code: "daemon-log", message: `${entry.level}: ${entry.message}` }];
}
export function checkRss(mib: number): Finding[] {
  return mib > 256
    ? [{ code: "daemon-rss", message: `Idle RSS ${mib.toFixed(1)} MiB exceeds 256 MiB` }]
    : [];
}
