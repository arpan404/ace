import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useNow } from "@/lib/time.ts";
import { useAddSource, useMarketSources, useRemoveSource } from "./market-api.ts";
import { Empty } from "./market-card.tsx";
import { count, failureSentence, readAtText } from "./market-model.ts";
import { part } from "@/lib/suit-part.ts";

/**
 * Where the marketplace reads from, pushed from Installed: ace's own market, then the git
 * catalogs the person added, each with when it was last read and Remove. A catalog is added by
 * its https git address.
 */
export function CatalogsPage() {
  const sources = useMarketSources();
  const add = useAddSource();
  const remove = useRemoveSource();
  const now = useNow();
  const [address, setAddress] = useState("");
  const [failed, setFailed] = useState<string>();
  const submit = () => {
    const typed = address.trim();
    if (!typed) return;
    setFailed(undefined);
    add.mutate(typed, {
      onSuccess: () => setAddress(""),
      onError: (error) => setFailed(failureSentence(error, "add")),
    });
  };
  return (
    <div className="mk-inner" data-width="read">
      <h1
        {...part("page-title", undefined, "market")}
        className="mk-display-sm"
        style={{ marginTop: 8 }}
      >
        Catalogs
      </h1>
      {sources.isError && !sources.data ? (
        <Empty title={failureSentence(sources.error, "read")} />
      ) : sources.data ? (
        <ul className="mk-rows" aria-label="Catalogs" style={{ marginTop: 24 }}>
          {sources.data.sources.map((source) => (
            <li key={source.id} className="mk-row">
              <span className="mk-words">
                <span className="mk-name">
                  {source.kind === "market" ? "ace's marketplace" : source.address}
                </span>
                <span className="mk-meta">
                  {[
                    count(source.entries, "entry", "entries"),
                    source.readAt === undefined
                      ? "Not read yet"
                      : `Read at ${readAtText(source.readAt, now)}`,
                    source.problem ? "Couldn't be read again" : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {source.kind === "git" && (
                <span className="mk-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${source.address}`}
                    disabled={remove.isPending}
                    onClick={() =>
                      remove.mutate(source.id, {
                        onError: (error) => setFailed(failureSentence(error, "removeSource")),
                      })
                    }
                  >
                    Remove
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <form
        style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 24 }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Input
          aria-label="Git catalog address"
          placeholder="https://github.com/owner/catalog"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        <Button type="submit" disabled={add.isPending || !address.trim()}>
          Add
        </Button>
      </form>
      {failed && (
        <p role="alert" className="mk-withdrawn-line" style={{ marginTop: 8 }}>
          {failed}
        </p>
      )}
    </div>
  );
}
