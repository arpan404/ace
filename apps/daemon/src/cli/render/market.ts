import type {
  MarketDiscover,
  MarketEntryDetail,
  MarketEntrySummary,
  MarketInstalled,
  MarketPublishAnswer,
  MarketPublisherPage,
  MarketSource,
} from "@ace/protocol/marketplace";
import { findingSentence } from "@ace/marketplace/signer";

/* The market's answers as a person reads them (ADR 0178 §3, §11, §12). Pure. */

const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const ref = (entry: { type: string; name: string }) => `${entry.type}/${entry.name}`;

/** One row: `suit/dusk-harbor 1.2.0  Dusk Harbor: A calm dark look. @arpan, reviewed`. */
export function entryRow(entry: MarketEntrySummary): string {
  const marks = [
    entry.publisher ? `@${entry.publisher.name}${entry.verified ? " (verified)" : ""}` : entry.from,
    entry.byAce ? "by ace" : entry.reviewed ? "reviewed" : undefined,
    entry.deprecated ? "deprecated" : undefined,
    entry.supported ? undefined : "not installable here",
  ].filter(Boolean);
  return `${ref(entry)}${entry.version ? ` ${entry.version}` : ""}  ${entry.title}${entry.line ? `: ${entry.line}` : ""}${marks.length ? ` (${marks.join(", ")})` : ""}`;
}

export function searchLines(value: { entries: readonly MarketEntrySummary[]; total: number }) {
  if (value.entries.length === 0) return ["Nothing in the market matches."];
  const more =
    value.total > value.entries.length
      ? [`${value.total - value.entries.length} more; narrow it with --type or --category.`]
      : [];
  return [...value.entries.map(entryRow), ...more];
}

export function entryLines(entry: MarketEntryDetail): string[] {
  const lines = [entryRow(entry.summary)];
  if (entry.description.trim()) lines.push("", entry.description.trim(), "");
  if (entry.installed)
    lines.push(`Installed: ${entry.installed.version} (${entry.installed.state}).`);
  for (const version of entry.versions.slice(0, 10)) {
    const notes = [
      version.withdrawn ? `withdrawn: ${version.withdrawn}` : undefined,
      version.deprecated ? `deprecated: ${version.deprecated}` : undefined,
    ].filter(Boolean);
    lines.push(
      `  ${version.version}  ${day(version.published)}${notes.length ? `  ${notes.join("; ")}` : ""}${version.changelog ? `  ${version.changelog.split("\n")[0]}` : ""}`,
    );
  }
  if (entry.versions.length > 10) lines.push(`  and ${entry.versions.length - 10} older.`);
  lines.push(`Install it with ace market install ${ref(entry.summary)}.`);
  return lines;
}

export function publisherLines(page: MarketPublisherPage): string[] {
  const { profile } = page;
  return [
    `@${profile.handle}: ${profile.displayName}${profile.verified ? ", verified" : ""}${page.official ? ", ace's own" : ""}`,
    ...(profile.bio ? [profile.bio] : []),
    `${page.entries.length} entries, ${page.downloads} downloads, joined ${day(profile.joined)}.`,
    ...page.entries.map(entryRow),
  ];
}

export function installedRow(entry: MarketInstalled): string {
  const state =
    entry.state === "on" ? undefined : `${entry.state}${entry.reason ? `: ${entry.reason}` : ""}`;
  const notes = [
    state,
    entry.update ? `update ${entry.update}` : undefined,
    entry.deprecated ? `deprecated: ${entry.deprecated}` : undefined,
  ].filter(Boolean);
  return `${ref(entry)} ${entry.version}  ${entry.title}${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

export function installedLines(installed: readonly MarketInstalled[]): string[] {
  return installed.length ? installed.map(installedRow) : ["Nothing is installed from the market."];
}

export function sourceLines(sources: readonly MarketSource[]): string[] {
  return sources.map(
    (source) =>
      `${source.id}  ${source.address}  ${source.enabled ? "on" : "off"}, ${source.entries} entries${source.readAt ? `, read ${day(source.readAt)}` : ""}${source.problem ? `. Last read failed: ${source.problem}` : ""}`,
  );
}

export function discoverLines(discover: MarketDiscover): string[] {
  const lines: string[] = [];
  if (discover.featured.length)
    lines.push("Featured", ...discover.featured.slice(0, 8).map((e) => `  ${entryRow(e)}`));
  if (discover.trending.length)
    lines.push("Trending", ...discover.trending.slice(0, 5).map((t) => `  ${entryRow(t.entry)}`));
  if (discover.fresh.length)
    lines.push("New", ...discover.fresh.slice(0, 5).map((e) => `  ${entryRow(e)}`));
  if (lines.length === 0) lines.push("The market has nothing to show yet.");
  lines.push(
    "",
    "  ace market search QUERY       find entries",
    "  ace market show TYPE/NAME     an entry, its publisher and versions",
    "  ace market install TYPE/NAME  read its review, then install",
    "  ace market installed          what's installed, and updates",
    "  ace help publishing           publishing your own",
  );
  return lines;
}

/** A publishing answer, in the publisher's words (ADR 0178 §12.2). */
export function publishLines(answer: MarketPublishAnswer): string[] {
  switch (answer.kind) {
    case "published":
      return [
        `Published ${answer.type}/${answer.name} ${answer.version}.`,
        answer.held
          ? "It waits for a maintainer to look first, because it's your first version."
          : "It waits for ace's signer, usually a few minutes.",
      ];
    case "draft": {
      const { draft } = answer;
      const report = draft.scan?.state === "done" ? draft.scan.report : undefined;
      const findings = report?.findings.filter((finding) => finding.level !== "note") ?? [];
      return [
        `Draft ${draft.id}: ${draft.type}/${draft.name} ${draft.version}, ${draft.files} files, ${Math.ceil(draft.size / 1024)} KB.`,
        ...(draft.scan?.state === "scanning" ? ["The market is still scanning it."] : []),
        ...(report
          ? findings.length
            ? findings.map((finding) => `  ${finding.level}: ${findingSentence(finding)}`)
            : ["The scan found nothing to warn about."]
          : []),
        ...draft.problems.map(
          (problem) => `  ${problem.path ? `${problem.path}: ` : ""}${problem.message}`,
        ),
        `Publish it with ace market draft publish ${draft.id}.`,
      ];
    }
    case "me": {
      const { me } = answer;
      const lines = [
        me.profile
          ? `@${me.profile.handle}: ${me.profile.displayName}${me.profile.verified ? ", verified" : ""}${me.state === "active" ? "" : ` (${me.state})`}`
          : "No publisher profile yet: ace market profile create --handle HANDLE --name NAME.",
      ];
      for (const entry of me.entries) lines.push(`${ref(entry)}  ${entry.title}`);
      for (const draft of me.drafts)
        lines.push(`Draft ${draft.id}: ${draft.type}/${draft.name} ${draft.version}`);
      for (const transfer of me.transfers)
        lines.push(
          `Transfer ${transfer.id}: ${ref(transfer)} ${transfer.direction === "incoming" ? `from @${transfer.from}` : `to @${transfer.to}`}`,
        );
      return lines;
    }
    case "entry": {
      const { entry } = answer;
      return [
        `${ref(entry.summary)}: ${entry.listing.title}${entry.latest ? `, showing ${entry.latest}` : ""}`,
        ...entry.versions.map(
          (version) =>
            `  ${version.version}  ${version.status}${version.deprecated ? `, deprecated: ${version.deprecated}` : ""}${version.changelog ? `  ${version.changelog.split("\n")[0]}` : ""}`,
        ),
        ...(entry.pendingListing ? ["A listing edit waits for a maintainer."] : []),
      ];
    }
    case "pending":
      return answer.what === "withdrawal"
        ? ["Withdrawal taken; ace's signer signs it next, and devices turn it off."]
        : ["The listing edit waits for a maintainer, because its scan asks for a look."];
    case "profile":
      return [`@${answer.profile.handle}: ${answer.profile.displayName}`];
    case "checked":
      return [
        `${answer.check.files.length} files would upload.`,
        ...answer.check.findings.map((finding) => `  ${finding.sentence}`),
      ];
    case "signals":
      return Object.entries(answer.signals).map(
        ([key, value]) => `${key}: ${JSON.stringify(value)}`,
      );
    case "verification":
      return [
        answer.verification.verified ? "Verified." : "Not verified.",
        ...answer.verification.challenges.map(
          (challenge) =>
            `  ${challenge.kind} ${challenge.subject}: ${challenge.state}${challenge.problem ? `: ${challenge.problem}` : ""}`,
        ),
      ];
    case "done":
      return ["Done."];
  }
}
