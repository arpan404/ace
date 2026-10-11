import { Link } from "@tanstack/react-router";
import type { ForgePrList, ForgePrSearch } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { PullRequestGlyph } from "@/components/pull-request-state.tsx";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs.tsx";
import { useState } from "react";

export function PrList(props: {
  workspaceId: string;
  value?: ForgePrList | undefined;
  query: ForgePrSearch;
  selected?: number;
  onQuery(query: ForgePrSearch): void;
  onOpen(number: number): void;
}) {
  const [search, setSearch] = useState(props.query.search);
  const [author, setAuthor] = useState(props.query.author);
  const [reviewer, setReviewer] = useState(props.query.reviewer);
  const change = (patch: Partial<ForgePrSearch>) =>
    props.onQuery({ ...props.query, ...patch, page: 1 });
  return (
    <section aria-label="Repository pull requests" className="space-y-4">
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
        <label className="text-sm">
          Sort
          <select
            className="ml-2 bg-input p-1 focus-ring"
            value={props.query.sort}
            onChange={(e) => {
              const sort = e.target.value;
              if (sort === "created" || sort === "updated" || sort === "comments") change({ sort });
            }}
          >
            <option value="updated">Recently updated</option>
            <option value="created">Created</option>
            <option value="comments">Comments</option>
          </select>
        </label>
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
            <ul className="divide-y divide-border">
              {props.value.items.map((pr) => (
                <li key={pr.ref.number} className="flex items-center gap-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-3 rounded-sm py-3 text-left focus-ring hover:bg-accent"
                    aria-current={pr.ref.number === props.selected ? "page" : undefined}
                    onClick={() => props.onOpen(pr.ref.number)}
                  >
                    <PullRequestGlyph state={pr.state} size={18} />
                    <span className="min-w-0">
                      <span className="block text-base font-medium">{pr.title}</span>
                      <span className="text-sm text-muted-foreground">
                        #{pr.ref.number} · {pr.author} · {pr.labels.join(", ")}
                      </span>
                    </span>
                  </button>
                  <Link
                    className="shrink-0 text-sm text-link hover:underline focus-ring"
                    to="/new"
                    search={{ project: props.workspaceId, pullRequest: pr.url }}
                  >
                    Work on PR
                  </Link>
                </li>
              ))}
            </ul>
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
