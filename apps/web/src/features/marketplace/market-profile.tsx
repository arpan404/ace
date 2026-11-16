import { Button } from "@/components/ui/button.tsx";
import { Empty, Section } from "./market-card.tsx";
import {
  useMarketMe,
  useMarketPublishPort,
  type MarketOwnEntryView,
  type MarketVersionStatusView,
} from "./market-later.ts";
import { typeWord } from "./market-model.ts";
import { Status } from "./market-marks.tsx";
import { useMarketNav } from "./market-nav.ts";
import { ProfileHead } from "./market-publisher.tsx";
import { Stage } from "./market-stage.tsx";

/*
 * Your marketplace profile (ADR 0173 §4): your head with Publish something, then what you
 * published with each one's state (live, waiting for review, not reviewed, withdrawn), and your
 * drafts. Drawn once the daemon answers `me`.
 */

const states: Readonly<
  Record<MarketVersionStatusView, { tone: "done" | "waiting" | "quiet" | "failed"; word: string }>
> = {
  live: { tone: "done", word: "Live" },
  waiting: { tone: "waiting", word: "Waiting for review" },
  "not-reviewed": { tone: "quiet", word: "Not reviewed" },
  withdrawn: { tone: "quiet", word: "Withdrawn" },
  blocked: { tone: "failed", word: "Blocked" },
};

function OwnRow(props: { entry: MarketOwnEntryView }) {
  const nav = useMarketNav();
  const { entry } = props;
  const key = { source: "market", type: entry.type, name: entry.name };
  const live =
    entry.status !== undefined && entry.status !== "withdrawn" && entry.status !== "blocked";
  const state = entry.status ? states[entry.status] : undefined;
  return (
    <div className="mk-mine-row">
      <Stage entry={key} size="small" />
      <div style={{ minWidth: 0 }}>
        <button
          type="button"
          className="mk-name"
          disabled={!live}
          onClick={() => nav.push({ kind: "entry", entry: key })}
        >
          {entry.title}
        </button>
        <span className="mk-meta" style={{ marginLeft: 8 }}>
          {typeWord(entry.type)}
        </span>
        {entry.version && state && (
          <div className="mk-versions">
            <div className="mk-version">
              <span className="mk-v">{entry.version}</span>
              <Status tone={state.tone}>{state.word}</Status>
              <span className="mk-meta">
                {entry.versions} {entry.versions === 1 ? "version" : "versions"}
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="mk-actions">
        {live && (
          <Button size="sm" variant="secondary" onClick={() => nav.push({ kind: "publish" })}>
            New version
          </Button>
        )}
      </div>
    </div>
  );
}

export function ProfilePage() {
  const nav = useMarketNav();
  const { me } = useMarketMe();
  const port = useMarketPublishPort();
  if (!me?.profile) return <Empty title="Your marketplace profile can't be shown yet" />;
  return (
    <div className="mk-inner" data-width="read">
      <ProfileHead
        profile={me.profile}
        entries={me.entries.length}
        actions={
          port && (
            <Button variant="primary" size="lg" onClick={() => nav.push({ kind: "publish" })}>
              Publish something
            </Button>
          )
        }
      />
      <Section title="Published">
        {me.entries.length ? (
          me.entries.map((entry) => <OwnRow key={`${entry.type}/${entry.name}`} entry={entry} />)
        ) : (
          <p className="mk-line">Nothing published yet.</p>
        )}
      </Section>
      <Section title="Drafts">
        {me.drafts.length ? (
          me.drafts.map((draft) => (
            <div key={draft.id} className="mk-mine-row">
              <Stage
                entry={{ source: "market", type: draft.type, name: draft.name }}
                size="small"
              />
              <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                <span className="mk-name">
                  {draft.title}
                  <span className="mk-meta" style={{ marginLeft: 8 }}>
                    {typeWord(draft.type)} · {draft.version}
                  </span>
                </span>
                <span className="mk-meta">
                  {draft.problems.length ? `${draft.problems.length} to fix` : "Ready to publish"}
                </span>
              </div>
              <div className="mk-actions" />
            </div>
          ))
        ) : (
          <p className="mk-line">No drafts.</p>
        )}
      </Section>
    </div>
  );
}
