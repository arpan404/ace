import type {
  MarketDraft,
  MarketDraftCheck,
  MarketDraftChecked,
  MarketMe,
  MarketOwnEntry,
  MarketOwnEntrySummary,
  MarketProfile,
  MarketPublishable,
  MarketSignals,
} from "@ace/protocol/marketplace";
import {
  count,
  dateText,
  decidedEachTime,
  effectWords,
  findingSentences,
  sentence,
  sizeText,
  typeWord,
} from "@ace/ui-core/market";

/*
 * Publishing and managing on the phone (#2548, #2554), in words: the publisher's own page, the
 * things they could publish, what a draft would upload, ace's checks on it, a listing's versions
 * and signals. Pure: the daemon's answers in, the phone's rows out, so Swift only draws.
 */

/** "1.2.0" → "1.2.1"; anything else starts at 1.0.0. */
export function nextVersion(version: string | undefined): string {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  return parts ? `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}` : "1.0.0";
}

const statusWords: Readonly<Record<string, string>> = {
  waiting: "Waiting for review",
  live: "Live",
  "not-reviewed": "Listed, not reviewed",
  withdrawn: "Withdrawn",
  blocked: "Blocked",
};
const statusText = (status: string | undefined) =>
  status ? (statusWords[status] ?? status) : "Not published yet";

export function profileRow(profile: MarketProfile) {
  return {
    handle: profile.handle,
    name: profile.displayName,
    bio: profile.bio,
    links: profile.links.map((link) => ({ label: link.label, url: link.url })),
    avatar: profile.avatar ?? null,
    verified: profile.verified,
  };
}

/** One of the publisher's listings, as Your listings shows it. */
export function ownRow(summary: MarketOwnEntrySummary) {
  const reports = summary.openReports;
  return {
    id: `${summary.type}/${summary.name}`,
    type: summary.type,
    name: summary.name,
    title: summary.title,
    line: summary.line,
    typeWord: typeWord(summary.type),
    version: summary.version ?? null,
    status: summary.status ?? null,
    statusText: summary.version
      ? `${summary.version} · ${statusText(summary.status)}`
      : statusText(summary.status),
    downloadsText: count(summary.downloads, "install"),
    reportsText: reports ? count(reports, "open report") : null,
  };
}

function draftRow(draft: MarketDraft) {
  return {
    id: draft.id,
    type: draft.type,
    name: draft.name,
    title: draft.title,
    typeWord: typeWord(draft.type),
    version: draft.version,
    stateText: draft.scan.state === "scanning" ? "Draft · Checking its files" : "Draft",
  };
}

/** The signed-in publisher's page: their profile, listings and drafts. */
export function meAnswer(me: MarketMe) {
  return {
    profile: me.profile ? profileRow(me.profile) : null,
    suspended: me.state !== "active",
    listings: me.entries.map(ownRow),
    drafts: me.drafts.map(draftRow),
    limitText: `${me.limits.uploadsToday} of ${me.limits.uploadsPerDay} uploads today`,
  };
}

/** Where one of the person's things stands in the market, and the version they'd publish. */
export function standing(me: MarketMe | undefined, type: string, name: string) {
  const draft = me?.drafts.find((each) => each.type === type && each.name === name);
  if (draft) return { state: "Draft", version: draft.version, draft: draft.id };
  const listed = me?.entries.find((each) => each.type === type && each.name === name);
  if (listed?.version)
    return {
      state: `${listed.version} is ${listed.status === "live" ? "live" : "published"}`,
      version: nextVersion(listed.version),
      draft: null,
    };
  return { state: "Never published", version: "1.0.0", draft: null };
}

const fromWords: Readonly<Record<MarketPublishable["from"], string>> = {
  spade: "In Spade",
  ace: "In ace's skills",
  plugin: "Installed plugin",
};

/**
 * One thing the person could publish. Its `id` is its source as JSON: the phone sends it back
 * to name what it picked, and the bridge parses it again before anything uses it.
 */
export function pickRow(picked: MarketPublishable, me: MarketMe | undefined) {
  const listed = me?.entries.find((each) => each.type === picked.type && each.name === picked.name);
  return {
    id: JSON.stringify(picked.source),
    type: picked.type,
    name: picked.name,
    title: listed?.title ?? picked.title,
    line: listed?.line ?? picked.line,
    fromText: fromWords[picked.from],
    /** A Spade bot's id, so a bot's own profile can open Publish on it. */
    bot: picked.source.kind === "spade-bot" ? picked.source.id : null,
    ...standing(me, picked.type, picked.name),
  };
}

const leftOutWhy = { hidden: "Hidden file", credential: "Named like a credential" } as const;
const refName = (ref: string) => ref.replace(/^spade-(?:skill|plugin)\//, "");

/** A bot's recipe as it would publish: what it shares, what it asks for, what it may do. */
function botReview(bot: NonNullable<MarketDraftCheck["bot"]>) {
  const { recipe } = bot;
  return {
    name: recipe.name,
    task: recipe.task,
    routines: recipe.routines.map((routine, index) => ({
      index,
      name: routine.name,
      schedule: routine.schedule,
      instruction: routine.instruction,
    })),
    skills: recipe.skills.map(refName),
    plugins: recipe.plugins.map(refName),
    apps: recipe.needs.connectors.map((need) => ({
      label: "id" in need ? need.id : need.url,
      why: need.why,
      required: need.required,
    })),
    /** What the bot may do beyond its own folder (ADR 0200 §3.4), each with its reason. */
    effects: recipe.effects.map((effect) => ({
      words: effectWords(effect),
      why: effect.why,
      asksEachTime: decidedEachTime(effect),
    })),
    leftOut: bot.leftOut,
  };
}

/** What publishing would upload, as the phone's review shows it before anything leaves. */
export function checkAnswer(check: MarketDraftCheck) {
  const bytes = check.files.reduce((sum, file) => sum + file.bytes, 0);
  const blocking = check.findings.filter((finding) => finding.blocking).length;
  return {
    hash: check.hash,
    filesText: `${count(check.files.length, "file")} · ${sizeText(bytes)}`,
    files: check.files.map((file) => ({
      path: file.path,
      sizeText: sizeText(file.bytes),
      binary: file.binary,
    })),
    leftOut: check.excluded.map((file) => ({ path: file.path, why: leftOutWhy[file.reason] })),
    findings: check.findings.map((finding, index) => ({
      id: index,
      where: finding.line ? `${finding.path}:${finding.line}` : finding.path,
      sentence: finding.sentence,
      blocking: finding.blocking,
    })),
    blocking,
    blockingText: blocking ? `${count(blocking, "thing")} to fix before you publish.` : null,
    bot: check.bot ? botReview(check.bot) : null,
  };
}

/**
 * The person's confirmation of `check`: every flagged text they saw, the binaries they ticked,
 * and for a bot its task with the routines they kept. A secret is never confirmable.
 */
export function confirmationOf(
  check: MarketDraftCheck,
  binaries: readonly string[],
  routines: readonly number[] | undefined,
): MarketDraftChecked {
  const accepted: string[] = [];
  const accept = (text: string) => {
    if (text && !accepted.includes(text)) accepted.push(text);
  };
  for (const finding of check.findings) if (!finding.blocking) accept(finding.text);
  const bot = check.bot;
  if (bot)
    for (const spans of [
      bot.name,
      bot.task,
      ...bot.routines.flatMap((r) => [r.name, r.instruction]),
    ])
      for (const span of spans) if (span.kind !== "secret") accept(span.text);
  const shipped = new Set(check.files.filter((file) => file.binary).map((file) => file.path));
  return {
    hash: check.hash,
    binaries: binaries.filter((path) => shipped.has(path)),
    accepted: accepted.slice(0, 500),
    ...(bot
      ? {
          recipe: {
            task: bot.recipe.task,
            routines: bot.recipe.routines
              .filter((_, index) => routines === undefined || routines.includes(index))
              .map(({ name, instruction, schedule }) => ({ name, instruction, schedule })),
          },
        }
      : {}),
  };
}

/** A draft and ace's checks on it: format problems first, then the scan's checks. */
export function draftAnswer(draft: MarketDraft) {
  const problems = draft.problems.map((problem, index) => ({
    id: `problem-${index}`,
    verdict: "block" as const,
    sentence: sentence([problem.path, problem.message].filter(Boolean).join(": ")),
    found: [] as string[],
  }));
  const scanned =
    draft.scan.state === "done"
      ? draft.scan.report.checks.map((check) => ({
          id: check.id,
          verdict: check.verdict,
          sentence: check.sentence,
          found:
            check.verdict === "pass" || draft.scan.state !== "done"
              ? []
              : findingSentences({
                  ...draft.scan.report,
                  findings: draft.scan.report.findings.filter(
                    (finding) => finding.check === check.id && finding.level !== "note",
                  ),
                }),
        }))
      : [];
  const checks = [...problems, ...scanned];
  const failing = checks.filter((check) => check.verdict === "block").length;
  return {
    draft: {
      id: draft.id,
      type: draft.type,
      name: draft.name,
      title: draft.title,
      version: draft.version,
      filesText: `${count(draft.files, "file")} · ${sizeText(draft.size)}`,
      scanning: draft.scan.state === "scanning",
      checks,
      failing,
      verdictText:
        draft.scan.state === "scanning"
          ? "ace is still checking its files."
          : failing
            ? `${count(failing, "check")} to fix before you publish.`
            : "Passes ace's checks.",
    },
  };
}

const reasonWords: Readonly<Record<string, string>> = {
  malware: "Malware",
  harmful: "Harmful",
  impersonation: "Impersonation",
  spam: "Spam",
  copyright: "Copyright",
  other: "Other",
};
const reportStateWords: Readonly<Record<string, string>> = {
  open: "Open",
  dismissed: "Dismissed",
  kept: "Kept",
  withdrawn: "Withdrew it",
  blocked: "Blocked it",
};

function signalsRow(signals: MarketSignals) {
  const downloads = signals.versions.reduce(
    (sum, version) => sum + version.downloads.slice(-30).reduce((a, b) => a + b, 0),
    0,
  );
  const { adoption } = signals;
  return {
    downloadsText: `${count(downloads, "install")} in the last 30 days`,
    adoptionText: adoption.latest
      ? `${Math.round(adoption.share * 100)}% on ${adoption.latest}`
      : null,
    reports: signals.reports.map((report, index) => ({
      id: index,
      reasonText: reasonWords[report.reason] ?? report.reason,
      stateText: reportStateWords[report.state] ?? report.state,
      dateText: dateText(report.at),
    })),
  };
}

/** One listing as its publisher manages it: its versions and, when read, its signals. */
export function manageAnswer(entry: MarketOwnEntry, signals: MarketSignals | undefined) {
  return {
    listing: {
      ...ownRow(entry.summary),
      pendingListing: entry.summary.pendingListing,
      description: entry.listing.description,
      categories: entry.listing.categories,
      versions: entry.versions.map((version) => ({
        version: version.version,
        status: version.status,
        statusText: statusText(version.status),
        dateText: dateText(version.published),
        downloadsText: count(version.downloads, "install"),
        reason: version.reason ? sentence(version.reason) : null,
        changelog: version.changelog,
        withdrawable: version.status !== "withdrawn" && version.status !== "blocked",
      })),
      withdrawable: entry.versions.some(
        (version) => version.status !== "withdrawn" && version.status !== "blocked",
      ),
      signals: signals ? signalsRow(signals) : null,
    },
  };
}
