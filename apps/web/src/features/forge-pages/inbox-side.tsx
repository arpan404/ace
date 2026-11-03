import type { ReactNode } from "react";
import {
  AtIcon,
  ChatCircleIcon,
  EyeIcon,
  TrayIcon,
  UserIcon,
  UsersIcon,
  type Icon,
} from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import type { InboxSearch } from "./inbox-model.ts";

/** One line of the filter column: its mark, words and count, the one on show filled. */
function Item(props: {
  icon?: Icon | undefined;
  label: ReactNode;
  count?: number | undefined;
  on: boolean;
  onPick(): void;
}) {
  const Glyph = props.icon;
  return (
    <button
      type="button"
      aria-current={props.on ? "true" : undefined}
      onClick={props.onPick}
      className={cn(
        "relative flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-ui transition-colors duration-(--motion-fast) focus-ring hover:bg-hover",
        props.on ? "bg-hover font-semibold text-foreground" : "text-foreground",
      )}
    >
      {props.on && (
        <span
          aria-hidden
          className="absolute top-1.5 bottom-1.5 -left-2 w-1 rounded-full bg-link"
        />
      )}
      {Glyph && <Glyph aria-hidden size={16} className="shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.count !== undefined && props.count > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums">{props.count}</span>
      )}
    </button>
  );
}

const filters: readonly {
  id: string;
  label: string;
  icon: Icon;
  patch: Partial<InboxSearch>;
}[] = [
  { id: "assign", label: "Assigned", icon: UserIcon, patch: { reason: "assign" } },
  {
    id: "participating",
    label: "Participating",
    icon: ChatCircleIcon,
    patch: { only: "participating" },
  },
  { id: "mention", label: "Mentioned", icon: AtIcon, patch: { reason: "mention" } },
  {
    id: "team_mention",
    label: "Team mentioned",
    icon: UsersIcon,
    patch: { reason: "team_mention" },
  },
  {
    id: "review_requested",
    label: "Review requested",
    icon: EyeIcon,
    patch: { reason: "review_requested" },
  },
];

const none: Partial<InboxSearch> = { reason: undefined, only: undefined, repo: undefined };

/**
 * The inbox's filter column, GitHub's: Inbox; the filters by why a notification came; then
 * each repository with its unread count. One is on at a time, and the column says which.
 */
export function InboxSide(props: {
  search: InboxSearch;
  unread: number | undefined;
  /** Repositories (`host/owner/name`) with their unread counts. */
  repositories: readonly { id: string; count: number }[];
  onSearch(patch: Partial<InboxSearch>): void;
}) {
  const { search } = props;
  const current = search.repo
    ? `repo:${search.repo}`
    : search.only === "participating"
      ? "participating"
      : (search.reason ?? "inbox");
  return (
    <nav aria-label="Notification views" className="flex flex-col gap-0.5">
      <Item
        icon={TrayIcon}
        label="Inbox"
        count={props.unread}
        on={current === "inbox"}
        onPick={() => props.onSearch(none)}
      />
      <h3 className="px-2 pt-4 pb-1 text-xs font-semibold text-muted-foreground">Filters</h3>
      {filters.map((filter) => (
        <Item
          key={filter.id}
          icon={filter.icon}
          label={filter.label}
          on={current === filter.id}
          onPick={() => props.onSearch({ ...none, ...filter.patch })}
        />
      ))}
      {props.repositories.length > 0 && (
        <>
          <h3 className="px-2 pt-4 pb-1 text-xs font-semibold text-muted-foreground">
            Repositories
          </h3>
          {props.repositories.map((repository) => (
            <Item
              key={repository.id}
              label={repository.id.split("/").slice(1).join("/")}
              count={repository.count}
              on={current === `repo:${repository.id}`}
              onPick={() => props.onSearch({ ...none, repo: repository.id })}
            />
          ))}
        </>
      )}
    </nav>
  );
}
