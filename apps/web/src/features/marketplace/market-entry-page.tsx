import type { MarketEntryDetail } from "@ace/protocol/marketplace";
import { Link } from "@tanstack/react-router";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { buttonLook } from "@/components/ui/button.tsx";
import { useNow } from "@/lib/time.ts";
import { useMarketEntry, useMarketReview, type EntryKey } from "./market-api.ts";
import {
  RecipeFacts,
  NeedRows,
  ReviewItems,
  RoutineRows,
  SuitLook,
  suitFromReview,
} from "./market-facts.tsx";
import {
  byline,
  entryAction,
  failureSentence,
  installBlock,
  readAtText,
  sizeText,
  typeWord,
} from "./market-model.ts";
import { useMarketPlace } from "./market-place.ts";
import { ListSkeleton, MarketPage, Quiet } from "./market-rows.tsx";

/**
 * One entry, as a full page in the main column (ADR 0168 §12): its title with one action at the
 * right (Install, Update or Installed), who published it, whether ace reviewed it, its
 * description, version and what it brings. A withdrawn entry, or one this ace can't install,
 * says so in place of the action.
 */
export function MarketEntryScreen(props: { entry: EntryKey }) {
  const read = useMarketEntry(props.entry);
  const detail = read.data?.entry;
  if (!detail)
    return (
      <MarketPage page="market-entry" title={read.isError ? "Marketplace" : ""}>
        {read.isError ? <Quiet>{failureSentence(read.error, "read")}</Quiet> : <ListSkeleton />}
      </MarketPage>
    );
  return <EntryPage entry={props.entry} detail={detail} />;
}

function EntryPage(props: { entry: EntryKey; detail: MarketEntryDetail }) {
  const { detail } = props;
  const { summary, installed } = detail;
  const action = entryAction(detail);
  const block = installBlock(detail);
  const now = useNow();
  const place = useMarketPlace();
  // What it brings is in its review, prepared once here and kept for Install.
  const review = useMarketReview(props.entry, {
    update: action === "update",
    enabled: action === "install" || action === "update",
  });
  const prepared = review.data;
  const suit = prepared && suitFromReview(prepared.review, prepared.items);
  const body = prepared?.review.body;
  const latest = detail.versions[0];
  return (
    <MarketPage
      page="market-entry"
      variant={summary.type}
      title={summary.title}
      action={
        action === "install" || action === "update" ? (
          <Link
            to="/marketplace/$source/$type/$name/review"
            params={props.entry}
            search={{ ...place.filterSearch, ...(action === "update" ? { update: 1 } : {}) }}
            {...buttonLook({ variant: "primary" }, "inline-flex shrink-0 items-center")}
          >
            {action === "update" ? "Update" : "Install"}
          </Link>
        ) : action === "installed" ? (
          <span className="shrink-0 pt-1 text-ui text-muted-foreground">Installed</span>
        ) : undefined
      }
    >
      <p className="mt-1 text-ui text-muted-foreground">
        {[typeWord(summary.type), byline(summary)].filter(Boolean).join(" · ")}
      </p>
      {!summary.reviewed && !summary.byAce && (
        <p className="mt-1 text-ui text-muted-foreground">Not reviewed by ace</p>
      )}
      {block && <p className="mt-3 text-ui text-foreground">{block}</p>}
      {installed?.state === "withdrawn" && (
        <p className="mt-3 text-ui text-foreground">
          Withdrawn by its publisher and turned off
          {installed.reason ? `: ${installed.reason}` : "."}
        </p>
      )}
      {detail.description && (
        <p className="mt-4 max-w-[68ch] text-md whitespace-pre-wrap text-foreground">
          {detail.description}
        </p>
      )}
      {suit && <SuitLook suit={suit} />}
      <SettingSection label="About">
        <SettingRow
          title="Version"
          description={
            latest
              ? `${latest.version} · ${sizeText(latest.size)} · Published ${readAtText(latest.published, now)}`
              : (summary.version ?? "")
          }
        />
        {installed && (
          <SettingRow
            title="Installed"
            description={`Version ${installed.version}${installed.update ? ` · ${installed.update} available` : ""}`}
          />
        )}
        <SettingRow title="Downloads" description={summary.downloads.toLocaleString("en-US")} />
        {summary.from && <SettingRow title="From" description={summary.from} />}
      </SettingSection>
      {body?.type === "spade-bot" && (
        <RecipeFacts body={body}>
          {body.routines.length > 0 && (
            <SettingSection label="Routines">
              <RoutineRows body={body} />
            </SettingSection>
          )}
          {body.needs.length > 0 && (
            <SettingSection label="Needs">
              <NeedRows body={body} />
            </SettingSection>
          )}
        </RecipeFacts>
      )}
      {prepared && <ReviewItems items={prepared.items} />}
      {review.isError && <Quiet>{failureSentence(review.error, "review")}</Quiet>}
    </MarketPage>
  );
}
