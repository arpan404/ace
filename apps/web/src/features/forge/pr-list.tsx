import { Link } from "@tanstack/react-router";
import type { ForgePrList, ForgePrSearch } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { PullRequestGlyph } from "@/components/pull-request-state.tsx";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs.tsx";
import { ChatCircleIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { PrTime, PrChecksPill } from "./pr-presentation.tsx";
import type { PrListExtensions } from "./pr-extensions.ts";
import { useState } from "react";

export function PrList(props: {
  workspaceId: string;
  value?: ForgePrList | undefined;
  query: ForgePrSearch;
  selected?: number | undefined;
  extensions?: PrListExtensions | undefined;
  onQuery(query: ForgePrSearch): void;
  onOpen(number: number): void;
}) {
  const [search, setSearch] = useState(props.query.search);
  const [author, setAuthor] = useState(props.query.author);
  const [reviewer, setReviewer] = useState(props.query.reviewer);
  const change = (patch: Partial<ForgePrSearch>) =>
    props.onQuery({ ...props.query, ...patch, page: 1 });
  return (
    <section aria-label="Repository pull requests" className="space-y-3">
      <Tabs
        value={props.query.state}
        onValueChange={(state) => {
          if (state === "open" || state === "draft" || state === "closed" || state === "merged")
            change({ state });
        }}
      >
        <TabsList aria-label="Pull request state" className="flex-wrap">
          {(["open", "draft", "closed", "merged"] as const).map((state) => (
            <TabsTab key={state} value={state}>
              {state[0]?.toUpperCase()}
              {state.slice(1)} {props.value?.counts[state]}
            </TabsTab>
          ))}
        </TabsList>
      </Tabs>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          change({ search, author, reviewer });
        }}
      >
        <label className="min-w-40 flex-1 text-sm">
          Search
          <Input value={search} onChange={(e) => setSearch(e.target.value)} maxLength={256} />
        </label>
        <label className="w-36 text-sm">
          Author
          <Input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            pattern="[\\w-]*"
            maxLength={100}
          />
        </label>
        <label className="w-36 text-sm">
          Review requested from
          <Input
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            pattern="[\\w-]*"
            maxLength={100}
          />
        </label>
        <Button type="submit">Search PRs</Button>
        <span className="flex items-center gap-2 text-sm">
          Sort
          <Select
            label="Sort"
            className="w-44"
            value={props.query.sort}
            onValueChange={(sort) => change({ sort })}
            options={[
              { value: "updated", label: "Recently updated" },
              { value: "created", label: "Created" },
              { value: "comments", label: "Comments" },
            ]}
          />
        </span>
        <Button onClick={() => change({ order: props.query.order === "asc" ? "desc" : "asc" })}>
          {props.query.order === "desc" ? "Newest first" : "Oldest first"}
        </Button>
      </form>
      {props.value && (
        <>
          <p className="text-sm text-muted-foreground">
            {props.value.total} matching pull requests
          </p>
          {(props.value.incomplete || props.value.truncated) && (
            <p role="status">
              {props.value.incomplete ? "GitHub returned incomplete search results. " : ""}
              {props.value.truncated
                ? "Only the first 1,000 matches are available. Narrow your search."
                : ""}
            </p>
          )}
          {props.value.items.length === 0 ? (
            <p>No pull requests match these filters.</p>
          ) : (
            <>
              {props.extensions?.beforeRows}
              <ul className="divide-y divide-border">
                {props.value.items.map((pr) => (
                  <li key={pr.ref.number}>
                    <button
                      type="button"
                      className="flex w-full flex-wrap items-start gap-2 rounded-sm px-2 py-2.5 text-left focus-ring hover:bg-accent"
                      aria-current={pr.ref.number === props.selected ? "page" : undefined}
                      onClick={() => props.onOpen(pr.ref.number)}
                    >
                      <PullRequestGlyph state={pr.state} size={18} />
                      <span className="min-w-40 flex-1">
                        <span className="block text-ui font-medium">{pr.title}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span>#{pr.ref.number}</span>
                          <span>{pr.state}</span>
                          <span>{pr.author}</span>
                          <PrTime at={pr.updatedAt} prefix="updated " />
                          {pr.labels.map((label) => (
                            <span key={label} className="rounded-sm bg-muted px-1.5">
                              {label}
                            </span>
                          ))}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-wrap items-center justify-end gap-3 text-xs text-muted-foreground">
                        <PrChecksPill ci={pr.ci ?? "unknown"} />
                        <span
                          className="inline-flex items-center gap-1"
                          aria-label={
                            pr.commentCount === undefined
                              ? "Comments unavailable"
                              : `${pr.commentCount} comments`
                          }
                        >
                          <ChatCircleIcon aria-hidden size={14} />
                          {pr.commentCount ?? "?"}
                        </span>
                        <span
                          className="inline-flex items-center gap-1"
                          aria-label={
                            pr.reviewCount === undefined
                              ? "Reviews unavailable"
                              : `${pr.reviewCount} reviews`
                          }
                        >
                          <CheckCircleIcon aria-hidden size={14} />
                          {pr.reviewCount ?? "?"}
                        </span>
                      </span>
                    </button>
                    <Link
                      className="ml-2 text-xs text-link hover:underline focus-ring"
                      to="/new"
                      search={{ project: props.workspaceId, pullRequest: pr.url }}
                    >
                      Work on PR
                    </Link>
                    {props.extensions?.actions?.(pr)}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="flex items-center gap-3">
            <Button
              disabled={props.query.page === 1}
              onClick={() => props.onQuery({ ...props.query, page: props.query.page - 1 })}
            >
              Previous page
            </Button>
            <span className="text-sm">Page {props.query.page}</span>
            <Button
              disabled={!props.value.nextPage}
              onClick={() =>
                props.value?.nextPage &&
                props.onQuery({ ...props.query, page: props.value.nextPage })
              }
            >
              Next page
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
