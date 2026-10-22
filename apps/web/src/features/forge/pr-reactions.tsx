import {
  ConfettiIcon,
  EyesIcon,
  HeartIcon,
  RocketLaunchIcon,
  SmileyIcon,
  SmileyMehIcon,
  SmileyStickerIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
} from "@phosphor-icons/react";
import type { ForgeReactionContent, ForgeReactionSubject } from "@ace/protocol";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuCheckboxItem, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { usePrReview } from "./pr-review-context.tsx";

const reactions: readonly {
  content: ForgeReactionContent;
  label: string;
  icon: typeof HeartIcon;
}[] = [
  { content: "+1", label: "Thumbs up", icon: ThumbsUpIcon },
  { content: "-1", label: "Thumbs down", icon: ThumbsDownIcon },
  { content: "laugh", label: "Laugh", icon: SmileyIcon },
  { content: "hooray", label: "Hooray", icon: ConfettiIcon },
  { content: "confused", label: "Confused", icon: SmileyMehIcon },
  { content: "heart", label: "Heart", icon: HeartIcon },
  { content: "rocket", label: "Rocket", icon: RocketLaunchIcon },
  { content: "eyes", label: "Eyes", icon: EyesIcon },
];
const same = (a: ForgeReactionSubject, b: ForgeReactionSubject) =>
  a.kind === b.kind && (a.kind === "pr" || (b.kind !== "pr" && a.commentId === b.commentId));

/** A subject's reactions and how to toggle the viewer's; undefined until they are known. */
function useReactions(subject: ForgeReactionSubject) {
  const review = usePrReview();
  const known = review?.state?.reactions;
  // Without the viewer's own reactions a press can't know whether it adds or removes.
  if (!review || !known) return undefined;
  const groups = known.find((entry) => same(entry.subject, subject))?.groups ?? [];
  return {
    groups,
    any: groups.some((group) => group.count > 0),
    disabled: !review.ready || review.pending,
    toggle: (content: ForgeReactionContent, viewer: boolean) =>
      void review.run({
        kind: viewer ? "reaction.remove" : "reaction.add",
        subject,
        content,
      }),
  };
}

type Reactions = NonNullable<ReturnType<typeof useReactions>>;

/** The picker: one row per reaction, the viewer's own checked. */
function ReactionMenu(props: { reactions: Reactions; className?: string | undefined }) {
  const { groups, disabled, toggle } = props.reactions;
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            icon={SmileyStickerIcon}
            label="Add reaction"
            size="sm"
            disabled={disabled}
            className={props.className}
          />
        }
      />
      <MenuContent align="start">
        {reactions.map(({ content, label, icon: Glyph }) => {
          const viewer = groups.some((g) => g.content === content && g.viewer);
          return (
            <MenuCheckboxItem
              key={content}
              checked={viewer}
              onCheckedChange={() => toggle(content, viewer)}
            >
              <span className="inline-flex items-center gap-2">
                <Glyph aria-hidden size={16} />
                {label}
              </span>
            </MenuCheckboxItem>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

/**
 * A subject's reactions as count chips, the viewer's own pressed, and a picker to add one.
 * Pressing a chip or a picker row toggles the viewer's reaction on GitHub. With `onlyWhenAny`,
 * nothing shows until someone reacted (the picker then sits elsewhere: `PrReactionPicker`).
 */
export function PrReactions(props: {
  subject: ForgeReactionSubject;
  className?: string;
  onlyWhenAny?: boolean;
}) {
  const state = useReactions(props.subject);
  if (!state || (props.onlyWhenAny && !state.any)) return null;
  const { groups, disabled, toggle } = state;
  return (
    <div
      role="group"
      aria-label="Reactions"
      className={cn("flex flex-wrap items-center gap-1", props.className)}
    >
      {reactions.map(({ content, label, icon: Glyph }) => {
        const group = groups.find((g) => g.content === content);
        if (!group || group.count === 0) return null;
        const said = `${label}: ${group.count}${group.viewer ? ", including you" : ""}`;
        return (
          <Tip key={content} label={said}>
            <button
              type="button"
              aria-label={said}
              aria-pressed={group.viewer}
              disabled={disabled}
              onClick={() => toggle(content, group.viewer)}
              className={cn(
                "inline-flex h-5 items-center gap-1 rounded-xs px-1.5 text-xs tabular-nums text-muted-foreground focus-ring",
                "bg-accent hover:text-foreground disabled:opacity-50",
                group.viewer && "text-foreground shadow-[inset_0_0_0_1px_var(--border-strong)]",
              )}
            >
              <Glyph aria-hidden size={12} weight={group.viewer ? "fill" : "regular"} />
              {group.count}
            </button>
          </Tip>
        );
      })}
      {/* Alone, its glyph (not its box) starts on the column's edge. */}
      <ReactionMenu reactions={state} className={state.any ? undefined : "-ml-1"} />
    </div>
  );
}

/** Just the add-reaction picker, for a heading's actions while nobody has reacted yet. */
export function PrReactionPicker(props: { subject: ForgeReactionSubject }) {
  const state = useReactions(props.subject);
  if (!state || state.any) return null;
  return <ReactionMenu reactions={state} />;
}
