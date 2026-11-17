import type { MarketEntrySummary, MarketProfile } from "@ace/protocol/marketplace";
import type { ReactNode } from "react";
import { Card, CardItem, Cards, Empty, Section } from "./market-card.tsx";
import { failureSentence, MarketFailure } from "./market-model.ts";
import { Avatar, Verified } from "./market-marks.tsx";
import { useMarketDiscover, useMarketPicture, useMarketPublisher } from "./market-publishing.ts";

/*
 * A collection, and a publisher's page (ADR 0173 §3, §6): their head (picture, name and seal,
 * handle, when they joined, bio and links), what they pinned, then their looks, bots and tools.
 * Drawn from the daemon's answer; without one, the page says it can't be shown.
 */

const joinedText = (at: number) =>
  new Date(at).toLocaleDateString("en-US", { month: "short", year: "numeric" });

export function ProfileHead(props: {
  profile: MarketProfile;
  entries: number;
  /** ace's own publisher, by the signed official list. */
  official?: boolean | undefined;
  actions?: ReactNode;
}) {
  const { profile } = props;
  const picture = useMarketPicture("avatar", profile.avatar);
  return (
    <div className="mk-profile-head">
      <Avatar name={profile.displayName} size={96} ace={props.official} picture={picture} />
      <div className="mk-profile-words">
        <h1 className="mk-display-sm">
          {profile.displayName}
          {profile.verified && <Verified />}
        </h1>
        <span className="mk-meta" style={{ fontSize: "var(--text-ui)" }}>
          @{profile.handle} · Joined {joinedText(profile.joined)} · {props.entries}{" "}
          {props.entries === 1 ? "entry" : "entries"}
        </span>
        {profile.bio && <p className="mk-bio">{profile.bio}</p>}
        {profile.links.length > 0 && (
          <div className="mk-profile-links">
            {profile.links.map((link) => (
              <a key={link.url} href={link.url} target="_blank" rel="noreferrer" title={link.url}>
                {link.label}
              </a>
            ))}
          </div>
        )}
      </div>
      {props.actions ? <div className="mk-profile-actions">{props.actions}</div> : <span />}
    </div>
  );
}

const key = (entry: MarketEntrySummary) => `${entry.source}/${entry.type}/${entry.name}`;

function Group(props: {
  title: string;
  entries: readonly MarketEntrySummary[];
  cols: 3 | 4;
  kinds?: boolean;
}) {
  if (!props.entries.length) return null;
  return (
    <Section title={props.title}>
      <Cards cols={props.cols} label={props.title}>
        {props.entries.map((entry) => (
          <CardItem key={key(entry)}>
            <Card entry={entry} showKind={props.kinds === true} />
          </CardItem>
        ))}
      </Cards>
    </Section>
  );
}

export function PublisherPage(props: { handle: string }) {
  const query = useMarketPublisher(props.handle);
  const page = query.data;
  if (query.isError && !page)
    return (
      <Empty
        title={
          query.error instanceof MarketFailure && query.error.code === "not_found"
            ? "There's no publisher by that name"
            : failureSentence(query.error, "read")
        }
      />
    );
  if (!page) return null;
  const pinned = new Set(page.pinned.map(key));
  const rest = page.entries.filter((entry) => !pinned.has(key(entry)));
  return (
    <div className="mk-inner">
      <ProfileHead
        profile={page.profile}
        entries={page.entries.length}
        official={page.official === true}
      />
      {page.pinned.length > 0 && (
        <Section title="Pinned">
          <Cards cols={2} label="Pinned">
            {page.pinned.map((entry) => (
              <CardItem key={key(entry)}>
                <Card entry={entry} big />
              </CardItem>
            ))}
          </Cards>
        </Section>
      )}
      <Group title="Looks" entries={rest.filter((entry) => entry.type === "suit")} cols={3} />
      <Group title="Bots" entries={rest.filter((entry) => entry.type === "spade-bot")} cols={4} />
      <Group
        title="Tools"
        entries={rest.filter((entry) => entry.type !== "suit" && entry.type !== "spade-bot")}
        cols={4}
        kinds
      />
    </div>
  );
}

export function CollectionPage(props: { id: string }) {
  const discover = useMarketDiscover();
  const collection = discover?.collections.find((each) => each.id === props.id);
  if (!discover) return null;
  if (!collection) return <Empty title="This collection isn't listed anymore" />;
  return (
    <div className="mk-inner">
      <div style={{ display: "grid", gap: 8, maxWidth: 640, marginTop: 8 }}>
        <h1 className="mk-display">{collection.title}</h1>
        <p className="mk-lead">{collection.line}</p>
        <span className="mk-meta">{collection.entries.length} entries · Chosen by ace</span>
      </div>
      <div style={{ marginTop: 40 }}>
        <Cards cols={4} phone="grid" label={collection.title}>
          {collection.entries.map((entry) => (
            <CardItem key={key(entry)}>
              <Card entry={entry} />
            </CardItem>
          ))}
        </Cards>
      </div>
    </div>
  );
}

/** A crumb's words for a publisher or collection page, once known. */
export function usePageTitle(kind: "publisher" | "collection", id: string): string {
  const publisher = useMarketPublisher(kind === "publisher" ? id : "").data;
  const collection = useMarketDiscover()?.collections.find((each) => each.id === id);
  if (kind === "publisher") return publisher?.profile.displayName ?? `@${id}`;
  return collection?.title ?? "Collection";
}
