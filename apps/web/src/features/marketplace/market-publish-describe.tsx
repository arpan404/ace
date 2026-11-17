import type { MarketEntrySummary } from "@ace/protocol/marketplace";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "./market-card.tsx";
import { Foot, Steps } from "./market-publish-parts.tsx";
import {
  useListingCategories,
  type MarketListingDraft,
  type MarketPublishItem,
} from "./market-publish-port.ts";

/*
 * The Describe step: the listing's name, one line, description, categories and version, with
 * the card as the marketplace will show it beside them. Publish sends the draft, then the words.
 */

export function Describe(props: {
  item: MarketPublishItem;
  listing: MarketListingDraft;
  onChange(listing: MarketListingDraft): void;
  now: number;
  onBack(): void;
  onPublish(): void;
  failed: { sentence: string; found: readonly string[] } | undefined;
}) {
  const { listing, item } = props;
  const categories = useListingCategories();
  const set = (patch: Partial<MarketListingDraft>) => props.onChange({ ...listing, ...patch });
  const toggle = (id: string) =>
    set({
      categories: listing.categories.includes(id)
        ? listing.categories.filter((each) => each !== id)
        : listing.categories.length < 3
          ? [...listing.categories, id]
          : listing.categories,
    });
  const preview: MarketEntrySummary = {
    source: "market",
    type: item.type,
    name: item.name,
    title: listing.title || item.title,
    line: listing.line || "One line about it",
    categories: [],
    keywords: [],
    reviewed: false,
    byAce: false,
    updated: 0,
    downloads: 0,
    supported: true,
  };
  return (
    <div className="mk-inner" data-width="form">
      <Steps now={props.now} />
      <div className="mk-describe">
        <div className="mk-form">
          <div>
            <label className="mk-label" htmlFor="mk-pub-name">
              Name
            </label>
            <input
              id="mk-pub-name"
              className="mk-field"
              value={listing.title}
              maxLength={120}
              onChange={(event) => set({ title: event.target.value })}
            />
          </div>
          <div>
            <label className="mk-label" htmlFor="mk-pub-line">
              One line <span className="mk-hint-count">{listing.line.length}/80</span>
            </label>
            <input
              id="mk-pub-line"
              className="mk-field"
              maxLength={80}
              value={listing.line}
              onChange={(event) => set({ line: event.target.value })}
            />
          </div>
          <div>
            <label className="mk-label" htmlFor="mk-pub-description">
              Description
            </label>
            <textarea
              id="mk-pub-description"
              className="mk-field"
              rows={4}
              value={listing.description}
              onChange={(event) => set({ description: event.target.value })}
            />
          </div>
          {categories.length > 0 && (
            <div>
              <span className="mk-label">
                Categories <span className="mk-hint-count">Up to 3</span>
              </span>
              <div className="mk-chips">
                {categories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className="mk-chip"
                    aria-pressed={listing.categories.includes(category.id)}
                    onClick={() => toggle(category.id)}
                  >
                    {category.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div style={{ maxWidth: 200 }}>
            <label className="mk-label" htmlFor="mk-pub-version">
              Version
            </label>
            <input
              id="mk-pub-version"
              className="mk-field"
              value={listing.version}
              onChange={(event) => set({ version: event.target.value })}
            />
          </div>
          {props.failed && (
            <div role="alert">
              <p className="mk-withdrawn-line">{props.failed.sentence}</p>
              {props.failed.found.map((found) => (
                <p key={found} className="mk-why">
                  {found}
                </p>
              ))}
            </div>
          )}
        </div>
        <aside className="mk-listing-preview" inert>
          <span className="mk-label">In the marketplace</span>
          <Card entry={preview} />
        </aside>
      </div>
      <Foot>
        <Button variant="ghost" size="lg" onClick={props.onBack}>
          Back
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={!listing.title.trim() || !/^\d+\.\d+\.\d+/.test(listing.version)}
          onClick={props.onPublish}
        >
          Publish
        </Button>
      </Foot>
    </div>
  );
}
