import type { MarketMe, MarketPickType } from "@ace/protocol/marketplace";
import { parseStoredBotFace } from "@ace/ui-core/bot-face";
import { keyOf } from "./market-publish-parts.tsx";
import type { MarketPublishItem } from "./market-publish-port.ts";
import { fromWords, pickedItem, samePick, usePublishables } from "./market-publish-pick.ts";
import { BotPicture, Stage } from "./market-stage.tsx";

/*
 * The Item step's lists: the person's own bots (face, name, task), skills (Spade's and ace's
 * library) and plugins, each a card that picks it.
 */

const nothing: Readonly<Record<MarketPickType, string>> = {
  "spade-bot": "You don't have a bot in Spade yet.",
  "spade-skill": "You haven't written a skill yet.",
  "spade-plugin": "You haven't installed a plugin from a folder on this machine.",
};

export function PickChoices(props: {
  type: MarketPickType;
  me: MarketMe | undefined;
  chosen: MarketPublishItem | undefined;
  onChoose(item: MarketPublishItem): void;
}) {
  const listed = usePublishables(props.type);
  const data = listed.data;
  // A bot shows its face; a skill or plugin has no picture, so it is a lockup.
  const bots = props.type === "spade-bot";
  if (!data) return listed.isError ? <p className="mk-line">These can't be listed now.</p> : null;
  return (
    <>
      {data.unavailable.map((line) => (
        <p key={line} className="mk-line">
          {line}
        </p>
      ))}
      {data.items.length === 0 ? (
        <p className="mk-line">{nothing[props.type]}</p>
      ) : (
        <div
          className="mk-cards"
          data-cols={bots ? "3" : "2"}
          data-form={bots ? "stage" : "lockup"}
          data-phone="grid"
          role="group"
          aria-label="Yours"
          style={{ marginTop: 32 }}
        >
          {data.items.map((each) => {
            const item = pickedItem(props.me, each);
            const face = parseStoredBotFace(each.face)?.face;
            return (
              <button
                key={JSON.stringify(each.source)}
                type="button"
                className="mk-choice"
                data-form={bots ? "stage" : "lockup"}
                aria-pressed={samePick(props.chosen, each)}
                onClick={() => props.onChoose(item)}
              >
                {each.type === "spade-bot" ? (
                  <BotPicture face={face} size={96} />
                ) : (
                  <Stage entry={keyOf(item)} size="small" />
                )}
                <span className="mk-card-words">
                  <span className="mk-name">{each.title}</span>
                  {each.line && <span className="mk-line">{each.line}</span>}
                  <span className="mk-meta">
                    {fromWords(each)} · {item.state}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
