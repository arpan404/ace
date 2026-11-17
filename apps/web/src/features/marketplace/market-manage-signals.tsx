import type { MarketEntryType, MarketSignals } from "@ace/protocol/marketplace";
import { Section } from "./market-card.tsx";
import { count, dateText } from "./market-model.ts";
import { useSignals } from "./market-publishing.ts";

/*
 * An entry's signals, for its publisher only (ADR 0173 §7): downloads over the last 30 days,
 * how many are on the latest version, and the reports people sent, in sentences.
 */

const reasonWords: Readonly<Record<MarketSignals["reports"][number]["reason"], string>> = {
  malware: "malware",
  harmful: "harmful",
  impersonation: "impersonation",
  spam: "spam",
  copyright: "copyright",
  other: "something else",
};

const stateWords: Readonly<Record<MarketSignals["reports"][number]["state"], string>> = {
  open: "open",
  dismissed: "dismissed",
  kept: "looked at, nothing changed",
  withdrawn: "the version was withdrawn",
  blocked: "the version was blocked",
};

/** The signals as sentences: pure, so the page says the same thing however it's laid out. */
export function signalSentences(signals: MarketSignals): string[] {
  const month = signals.versions.reduce(
    (sum, version) => sum + version.downloads.slice(-30).reduce((a, b) => a + b, 0),
    0,
  );
  const lines = [`${count(month, "download")} in the last 30 days.`];
  if (signals.adoption.latest && month > 0)
    lines.push(
      `${Math.round(signals.adoption.share * 100)}% of them are on ${signals.adoption.latest}.`,
    );
  if (!signals.reports.length) lines.push("No one has reported it.");
  return lines;
}

export function SignalsSection(props: { type: MarketEntryType; name: string }) {
  const signals = useSignals(props.type, props.name, true).data;
  if (!signals) return null;
  return (
    <Section title="Signals">
      <div style={{ display: "grid", gap: 4 }}>
        {signalSentences(signals).map((line) => (
          <p key={line} className="mk-line" style={{ margin: 0 }}>
            {line}
          </p>
        ))}
      </div>
      {signals.reports.length > 0 && (
        <ul className="mk-rows" aria-label="Reports" style={{ marginTop: 12 }}>
          {signals.reports.map((report) => (
            <li key={`${report.at}:${report.reason}:${report.state}`} className="mk-line">
              Reported for {reasonWords[report.reason]} on {dateText(report.at)}:{" "}
              {stateWords[report.state]}.
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
