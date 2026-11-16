import { useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useNow } from "@/lib/time.ts";
import { useAddSource, useMarketSources, useRemoveSource } from "./market-api.ts";
import { count, failureSentence, readAtText } from "./market-model.ts";
import { ListSkeleton, MarketPage, Quiet } from "./market-rows.tsx";

/**
 * Where the marketplace reads from: ace's own market, then the git catalogs the person added,
 * each with when it was last read and Remove. A catalog is added by its https git address.
 */
export function MarketCatalogsScreen() {
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
    <MarketPage title="Catalogs">
      {sources.isError && !sources.data ? (
        <Quiet>{failureSentence(sources.error, "read")}</Quiet>
      ) : !sources.data ? (
        <ListSkeleton />
      ) : (
        <SettingSection label="Catalogs">
          {sources.data.sources.map((source) => (
            <SettingRow
              key={source.id}
              inline
              title={source.kind === "market" ? "ace's marketplace" : source.address}
              description={[
                count(source.entries, "entry", "entries"),
                source.readAt === undefined
                  ? "Not read yet"
                  : `Read at ${readAtText(source.readAt, now)}`,
                source.problem ? "Couldn't be read again" : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              {source.kind === "git" && (
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
              )}
            </SettingRow>
          ))}
        </SettingSection>
      )}
      <form
        className="mt-6 flex items-center gap-2"
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
        <p role="alert" className="mt-2 text-ui text-destructive">
          {failed}
        </p>
      )}
    </MarketPage>
  );
}
