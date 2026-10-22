import { CheckCircleIcon, RecordIcon } from "@phosphor-icons/react";
import { PersonAvatar } from "@/components/person-avatar.tsx";
import { PullRequestGlyph, pullRequestTone } from "@/components/pull-request-state.tsx";
import { MessageAvatar } from "@/components/ui/message.tsx";
import { Popover, PopoverContent } from "@/components/ui/popover.tsx";
import { cn } from "@/lib/cn.ts";
import { menuItem } from "@/components/ui/menu-styles.ts";
import type { CompletionReference } from "./completion-source.ts";
import type { CompletionItem } from "./use-completions.ts";

const stateWords = { open: "Open", draft: "Draft", closed: "Closed", merged: "Merged" } as const;

/** What a row is called aloud: the login and name, or the number, title and state. */
function spoken(item: CompletionItem): string {
  if (item.kind === "person")
    return item.person.name ? `${item.person.login}, ${item.person.name}` : item.person.login;
  const { number, title, kind, state } = item.reference;
  return `#${number} ${title}, ${stateWords[state].toLowerCase()} ${kind === "pr" ? "pull request" : "issue"}`;
}

function ReferenceGlyph(props: { reference: CompletionReference }) {
  const { kind, state } = props.reference;
  if (kind === "pr") return <PullRequestGlyph state={state} size={16} />;
  const Glyph = state === "open" ? RecordIcon : CheckCircleIcon;
  return (
    <Glyph
      aria-hidden
      size={16}
      className={pullRequestTone(state === "open" ? "open" : "merged")}
    />
  );
}

function Row(props: { item: CompletionItem }) {
  const { item } = props;
  if (item.kind === "person") {
    const { login, name, avatarUrl } = item.person;
    return (
      <>
        {avatarUrl ? (
          <PersonAvatar name={login} url={avatarUrl} className="size-5 min-w-5" />
        ) : (
          // No picture to relay: the initial, without asking the daemon.
          <MessageAvatar aria-hidden className="size-5 min-w-5 self-center text-xs">
            {login.slice(0, 1).toUpperCase()}
          </MessageAvatar>
        )}
        <span className="font-medium">{login}</span>
        {name && <span className="min-w-0 truncate text-muted-foreground">{name}</span>}
      </>
    );
  }
  const { number, title, kind, state } = item.reference;
  return (
    <>
      <ReferenceGlyph reference={item.reference} />
      <span className="shrink-0 text-muted-foreground tabular-nums">#{number}</span>
      <span className="min-w-0 truncate">{title}</span>
      <span className="ml-auto shrink-0 pl-3 text-xs text-subtle-foreground">
        {stateWords[state]} {kind === "pr" ? "PR" : "issue"}
      </span>
    </>
  );
}

/**
 * The `@` or `#` suggestions under the caret. Focus stays in the text: the field's keys move
 * the highlight, and a pointer press picks a row without taking focus from it.
 */
export function CompletionList(props: {
  id: string;
  label: string;
  items: readonly CompletionItem[];
  active: number;
  anchor: () => DOMRect;
  onHighlight(index: number): void;
  onChoose(item: CompletionItem): void;
  onDismiss(): void;
}) {
  return (
    <Popover
      open
      onOpenChange={(open, details) => {
        if (!open && details.reason === "escape-key") props.onDismiss();
      }}
    >
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        anchor={{ getBoundingClientRect: props.anchor }}
        initialFocus={false}
        finalFocus={false}
        className="w-80 max-w-[calc(100vw-16px)]"
      >
        <div id={props.id} role="listbox" aria-label={props.label}>
          {props.items.map((item, index) => (
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- keys pick through the field's aria-activedescendant
            <div
              key={item.id}
              id={`${props.id}-${index}`}
              role="option"
              aria-label={spoken(item)}
              aria-selected={index === props.active}
              data-highlighted={index === props.active ? "" : undefined}
              className={cn(menuItem, "cursor-pointer")}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => index !== props.active && props.onHighlight(index)}
              onClick={() => props.onChoose(item)}
            >
              <Row item={item} />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
