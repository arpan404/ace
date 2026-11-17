import type {
  MarketDraft,
  MarketOwnEntrySummary,
  MarketOwnVersion,
  MarketVersionStatus,
} from "@ace/protocol/marketplace";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Empty, Section } from "./market-card.tsx";
import { count, dateText, failureSentence, typeWord } from "./market-model.ts";
import { Status } from "./market-marks.tsx";
import { useMarketNav } from "./market-nav.ts";
import { MakeProfile, ProfileEditor } from "./market-profile-edit.tsx";
import { useMarketMe, useOwnEntry, usePublishAction } from "./market-publishing.ts";
import { ProfileHead } from "./market-publisher.tsx";
import { Stage } from "./market-stage.tsx";

/*
 * Your marketplace profile (ADR 0173 §4): your head with Edit profile and Publish something, then
 * each thing you published with every version's state (live, waiting for review, not reviewed,
 * withdrawn, blocked), and your drafts. Signed out, it says to sign in; signed in without a
 * profile, it makes one.
 */

type Tone = "done" | "waiting" | "quiet" | "failed";
const states: Readonly<Record<MarketVersionStatus, { tone: Tone; word: string }>> = {
  live: { tone: "done", word: "Live" },
  waiting: { tone: "waiting", word: "Waiting for review" },
  "not-reviewed": { tone: "quiet", word: "Not reviewed" },
  withdrawn: { tone: "quiet", word: "Withdrawn" },
  blocked: { tone: "failed", word: "Blocked" },
};

/** A version's state in words: a held one waits on a maintainer, not only the signer. */
export function VersionState(props: { version: Pick<MarketOwnVersion, "status" | "held"> }) {
  const state = states[props.version.status];
  return (
    <Status tone={state.tone}>
      {props.version.status === "waiting" && props.version.held
        ? "Waiting for a maintainer"
        : state.word}
    </Status>
  );
}

const marketKey = (entry: { type: string; name: string }) => ({
  source: "market",
  type: entry.type,
  name: entry.name,
});

function OwnRow(props: { entry: MarketOwnEntrySummary }) {
  const nav = useMarketNav();
  const { entry } = props;
  const own = useOwnEntry(entry.type, entry.name).data;
  const versions = own?.versions ?? [];
  const live = entry.status === "live" || entry.status === "not-reviewed";
  return (
    <div className="mk-mine-row">
      <Stage entry={{ ...marketKey(entry), previews: own?.listing.previews }} size="small" />
      <div style={{ minWidth: 0 }}>
        <button
          type="button"
          className="mk-name"
          disabled={!live || entry.visibility === "unlisted"}
          onClick={() => nav.push({ kind: "entry", entry: marketKey(entry) })}
        >
          {entry.title}
        </button>
        <span className="mk-meta" style={{ marginLeft: 8 }}>
          {[
            typeWord(entry.type),
            entry.visibility === "unlisted" ? "Unlisted" : undefined,
            entry.archived ? "Archived" : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <div className="mk-versions" aria-label={`${entry.title}'s versions`}>
          {(versions.length
            ? versions
            : entry.version && entry.status
              ? [{ version: entry.version, status: entry.status, held: false, published: 0 }]
              : []
          ).map((version) => (
            <div key={version.version} className="mk-version">
              <span className="mk-v">{version.version}</span>
              <VersionState version={version} />
              {version.published > 0 && (
                <span className="mk-meta">{dateText(version.published)}</span>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="mk-actions">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => nav.push({ kind: "manage", type: entry.type, name: entry.name })}
        >
          Manage
        </Button>
        {live && (
          <Button size="sm" variant="secondary" onClick={() => nav.push({ kind: "publish" })}>
            New version
          </Button>
        )}
      </div>
    </div>
  );
}

const draftLine = (draft: MarketDraft) => {
  if (draft.problems.length) return `${count(draft.problems.length, "thing")} to fix`;
  if (draft.scan.state === "scanning") return "Being checked";
  if (draft.scan.report.verdict === "block") return "Its check found something to fix";
  return "Ready to publish";
};

function DraftRow(props: { draft: MarketDraft }) {
  const nav = useMarketNav();
  const action = usePublishAction();
  const { draft } = props;
  return (
    <div className="mk-mine-row">
      <Stage entry={marketKey(draft)} size="small" />
      <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <span className="mk-name">
          {draft.title}
          <span className="mk-meta" style={{ marginLeft: 8 }}>
            {typeWord(draft.type)} · {draft.version}
          </span>
        </span>
        <span className="mk-meta">
          {draftLine(draft)} · {dateText(draft.updated)}
        </span>
      </div>
      <div className="mk-actions">
        <Button
          size="sm"
          variant="ghost"
          disabled={action.isPending}
          onClick={() => action.mutate({ action: "draftDelete", id: draft.id })}
        >
          Delete
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => nav.push({ kind: "publish", draft: draft.id })}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

export function ProfilePage() {
  const nav = useMarketNav();
  const { me, signedOut, failed } = useMarketMe();
  const [editing, setEditing] = useState(false);
  if (signedOut)
    return (
      <div className="mk-inner" data-width="read">
        <Empty title="Sign in to publish" line="Publishing uses this machine's ace account.">
          <Button variant="primary" size="lg" render={<Link to="/settings/profile" />}>
            Sign in
          </Button>
        </Empty>
      </div>
    );
  if (failed) return <Empty title={failureSentence(undefined, "read")} />;
  if (!me) return null;
  if (!me.profile)
    return (
      <div className="mk-inner" data-width="read">
        <MakeProfile />
      </div>
    );
  return (
    <div className="mk-inner" data-width="read">
      {editing ? (
        <ProfileEditor profile={me.profile} onDone={() => setEditing(false)} />
      ) : (
        <ProfileHead
          profile={me.profile}
          entries={me.entries.length}
          actions={
            <>
              <Button variant="secondary" size="lg" onClick={() => setEditing(true)}>
                Edit profile
              </Button>
              <Button variant="primary" size="lg" onClick={() => nav.push({ kind: "publish" })}>
                Publish something
              </Button>
            </>
          }
        />
      )}
      <Section title="Published">
        {me.entries.length ? (
          me.entries.map((entry) => <OwnRow key={`${entry.type}/${entry.name}`} entry={entry} />)
        ) : (
          <p className="mk-line">Nothing published yet.</p>
        )}
      </Section>
      <Section title="Drafts">
        {me.drafts.length ? (
          me.drafts.map((draft) => <DraftRow key={draft.id} draft={draft} />)
        ) : (
          <p className="mk-line">No drafts.</p>
        )}
      </Section>
    </div>
  );
}
