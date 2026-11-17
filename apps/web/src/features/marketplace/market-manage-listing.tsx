import type { MarketListingEdit, MarketOwnEntry } from "@ace/protocol/marketplace";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Section } from "./market-card.tsx";
import { findingSentences } from "./market-model.ts";
import { useListingCategories } from "./market-publish-port.ts";

/*
 * An entry's listing words, edited in place (ADR 0173 §5): name, one line, description and
 * categories. An edit the scan holds waits for a maintainer; the page says so with what it found.
 */

export function ListingEditor(props: {
  entry: MarketOwnEntry;
  pending: boolean;
  onSave(listing: MarketListingEdit): void;
}) {
  const { entry } = props;
  const categories = useListingCategories();
  const [listing, setListing] = useState<MarketListingEdit>(entry.listing);
  const set = (patch: Partial<MarketListingEdit>) =>
    setListing((before) => ({ ...before, ...patch }));
  const changed = JSON.stringify(listing) !== JSON.stringify(entry.listing);
  const toggle = (id: string) =>
    set({
      categories: listing.categories.includes(id)
        ? listing.categories.filter((each) => each !== id)
        : [...listing.categories, id].slice(0, 3),
    });
  return (
    <Section title="Listing">
      {entry.pendingListing && (
        <div className="mk-line" style={{ display: "grid", gap: 4, marginBottom: 16 }}>
          <span>Your last edit waits for a maintainer before it shows.</span>
          {findingSentences(entry.pendingListing.scan).map((found) => (
            <span key={found} className="mk-why">
              {found}
            </span>
          ))}
        </div>
      )}
      <div className="mk-form" style={{ maxWidth: 560 }}>
        <div>
          <label className="mk-label" htmlFor="mk-edit-title">
            Name
          </label>
          <input
            id="mk-edit-title"
            className="mk-field"
            maxLength={120}
            value={listing.title}
            onChange={(event) => set({ title: event.target.value })}
          />
        </div>
        <div>
          <label className="mk-label" htmlFor="mk-edit-line">
            One line
          </label>
          <input
            id="mk-edit-line"
            className="mk-field"
            maxLength={300}
            value={listing.line}
            onChange={(event) => set({ line: event.target.value })}
          />
        </div>
        <div>
          <label className="mk-label" htmlFor="mk-edit-description">
            Description
          </label>
          <textarea
            id="mk-edit-description"
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
        <div className="mk-actions" style={{ justifyContent: "flex-start" }}>
          <Button
            variant="secondary"
            disabled={!changed || !listing.title.trim() || props.pending}
            onClick={() => props.onSave(listing)}
          >
            Save listing
          </Button>
        </div>
      </div>
    </Section>
  );
}
