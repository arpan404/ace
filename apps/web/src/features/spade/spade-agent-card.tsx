// oxlint-disable react/no-array-index-key -- a card's blocks, rows and cells have no ids; their place is theirs.
import {
  type SpadeAgentStyle,
  type SpadeAvatar,
  type SpadeCardAction,
  type SpadeCardBlock,
  type SpadeCardRow,
} from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { buttonLook } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { part } from "@/lib/suit-part.ts";
import { accentFill, useCardAccent } from "./spade-accent.ts";
import { CardActions, CardWord } from "./spade-card.tsx";
import { Attachments } from "./spade-attachment.tsx";

/*
 * A card a bot showed (ADR 0200 §5.1, docs/design/spade.md): its data drawn with ace's own parts
 * on the bot's bubble, never a page. It is the bot's output, not something that waits on the
 * person, so it sits on the bubble's fill with no edge or lift. The bot's own accent marks only
 * its title rule (§5.3). A Suit reaches it as `card` `spade-agent`.
 */

/** Press a choice; resolves with what to say under the card when Spade refused it. */
export type SpadeCardChoose = (
  cardId: string,
  version: number,
  action: string,
) => Promise<string | undefined>;

export function SpadeAgentCard(props: {
  item: SpadeCardRow;
  avatar: SpadeAvatar;
  /** The bot's `style` (§5.3): its accent over its face's colour when it holds. */
  style?: SpadeAgentStyle | undefined;
  botName: string;
  onChoose: SpadeCardChoose;
  /** Opens one of the bot's panels beside its chat; its buttons are left out without it. */
  onOpenPanel?: ((panel: string) => void) | undefined;
}) {
  const { item } = props;
  const accent = useCardAccent(props);
  return (
    <section
      {...part("card", undefined, "spade-agent")}
      aria-label={`${props.botName}: ${item.card.title}`}
      style={accent}
      className="@container/card flex w-full max-w-150 min-w-0 flex-col gap-3 rounded-(--chat-bubble-radius) bg-chat-bubble px-(--chat-bubble-x) py-4 wrap-anywhere"
    >
      <header className="flex flex-col gap-2">
        <h3 className="text-base leading-6 font-medium text-foreground">{item.card.title}</h3>
        <span
          aria-hidden
          data-agent-accent=""
          className={cn("h-0.5 w-6 rounded-full", accentFill)}
        />
      </header>
      {item.card.blocks.map((block, index) => (
        <Block
          key={`${item.version}:${index}`}
          block={block}
          item={item}
          onChoose={props.onChoose}
          onOpenPanel={props.onOpenPanel}
        />
      ))}
    </section>
  );
}

function Block(props: {
  block: SpadeCardBlock;
  item: SpadeCardRow;
  onChoose: SpadeCardChoose;
  onOpenPanel: ((panel: string) => void) | undefined;
}) {
  const { block } = props;
  switch (block.kind) {
    case "fields":
      return (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-ui">
          {block.rows.map((row, index) => (
            <div key={index} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "metric":
      return (
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">{block.label}</span>
          <span className="flex items-baseline gap-1.5 tabular-nums">
            <span className="text-2xl leading-8 font-semibold text-foreground">{block.value}</span>
            {block.unit && <span className="text-ui text-muted-foreground">{block.unit}</span>}
            {block.change && <span className="text-ui text-muted-foreground">{block.change}</span>}
          </span>
        </div>
      );
    case "progress": {
      const share = block.max > 0 ? Math.round((block.value / block.max) * 100) : 0;
      const words = `${formatNumber(block.value)} of ${formatNumber(block.max)}`;
      return (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3 text-ui">
            <span className="text-muted-foreground">{block.label ?? "Progress"}</span>
            <span className="text-foreground tabular-nums">{words}</span>
          </div>
          <div
            role="progressbar"
            aria-label={block.label ?? "Progress"}
            aria-valuemin={0}
            aria-valuemax={block.max}
            aria-valuenow={block.value}
            aria-valuetext={words}
            className="h-1 w-full overflow-hidden rounded-full bg-chat-well"
          >
            <div className="h-full rounded-full bg-foreground" style={{ width: `${share}%` }} />
          </div>
        </div>
      );
    }
    case "table":
      return (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full border-collapse text-left text-ui">
            <thead>
              <tr>
                {block.columns.map((column, index) => (
                  <th
                    key={index}
                    scope="col"
                    className="px-1 pb-1 font-normal text-muted-foreground"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, at) => (
                <tr key={at} className="border-t border-border/60">
                  {row.map((cell, index) => (
                    <td key={index} className="px-1 py-1 text-foreground tabular-nums">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List
          className={cn(
            "flex flex-col gap-0.5 ps-5 text-ui text-foreground",
            block.ordered ? "list-decimal" : "list-disc",
          )}
        >
          {block.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </List>
      );
    }
    case "image":
      return (
        <figure aria-label={block.alt} className="flex flex-col gap-1">
          <Attachments images={[block.image]} documents={[]} side="bot" />
        </figure>
      );
    case "link":
      return (
        <a
          href={block.url}
          target="_blank"
          rel="noopener noreferrer"
          className="w-fit text-ui text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground focus-ring"
        >
          {block.label ?? block.host}
          {block.label && <span className="text-muted-foreground"> · {block.host}</span>}
        </a>
      );
    case "actions":
      return (
        <Actions
          actions={block.actions}
          item={props.item}
          onChoose={props.onChoose}
          onOpenPanel={props.onOpenPanel}
        />
      );
    case "unknown":
      return null;
  }
}

function Actions(props: {
  actions: readonly SpadeCardAction[];
  item: SpadeCardRow;
  onChoose: SpadeCardChoose;
  onOpenPanel: ((panel: string) => void) | undefined;
}) {
  const { item, onOpenPanel } = props;
  const [pressing, setPressing] = useState<string>();
  const [refused, setRefused] = useState<{ version: number; words: string }>();
  const chosen = item.chosen;
  const choose = (id: string) => {
    if (pressing) return;
    setPressing(id);
    setRefused(undefined);
    void props.onChoose(item.cardId, item.version, id).then((words) => {
      setPressing(undefined);
      if (words) setRefused({ version: item.version, words });
    });
  };
  const choices = props.actions.filter(
    (a): a is Extract<SpadeCardAction, { kind: "choose" }> => a.kind === "choose",
  );
  const opens = props.actions.filter(
    (a) => a.kind === "open" || (a.kind === "open_panel" && onOpenPanel),
  );
  const [mainChoice, ...otherChoices] = choices;
  const openLinks = opens.length > 0 && (
    <div className="flex flex-wrap items-center gap-1">
      {opens.map((action) =>
        action.kind === "open" ? (
          <a
            key={action.url}
            href={action.url}
            target="_blank"
            rel="noopener noreferrer"
            {...buttonLook(
              { variant: "ghost" },
              "h-(--spade-pill-button) gap-1.5 rounded-full px-3.5 text-ui hover:bg-hover",
            )}
          >
            {action.label}
            <span className="text-subtle-foreground">{action.host}</span>
          </a>
        ) : action.kind === "open_panel" && onOpenPanel ? (
          <CardWord key={`panel:${action.panel}`} onClick={() => onOpenPanel(action.panel)}>
            {action.label}
          </CardWord>
        ) : null,
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      {chosen ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-ui text-muted-foreground">
            You chose <span className="text-foreground">{chosen.label}</span>.
          </p>
          {openLinks}
        </div>
      ) : mainChoice ? (
        <CardActions
          aside={openLinks}
          secondary={otherChoices.map((action) => ({
            key: action.id,
            label: action.label,
            disabled: pressing !== undefined,
            busy: pressing === action.id,
            onClick: () => choose(action.id),
          }))}
          primary={{
            key: mainChoice.id,
            label: mainChoice.label,
            disabled: pressing !== undefined,
            busy: pressing === mainChoice.id,
            onClick: () => choose(mainChoice.id),
          }}
        />
      ) : (
        openLinks
      )}
      {refused?.version === item.version && (
        <p role="status" className="text-ui text-muted-foreground">
          {refused.words}
        </p>
      )}
    </div>
  );
}

const formatNumber = (value: number) =>
  Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
