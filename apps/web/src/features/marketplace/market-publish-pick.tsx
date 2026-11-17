import type { MarketMe, MarketPickType, Recipe } from "@ace/protocol/marketplace";
import { parseStoredBotFace } from "@ace/ui-core/bot-face";
import { keyOf } from "./market-publish-parts.tsx";
import type { MarketPublishItem } from "./market-publish-port.ts";
import {
  fromWords,
  needLabel,
  pickedItem,
  refName,
  samePick,
  usePublishables,
} from "./market-publish-pick.ts";
import { BotPicture, Stage } from "./market-stage.tsx";

/*
 * The Item step's lists: the person's own bots (face, name, task), skills (Spade's and ace's
 * library) and plugins, each a card that picks it; and a bot's recipe shown before Next, so the
 * person sees what publishing it sends.
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
          data-cols="3"
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
                aria-pressed={samePick(props.chosen, each)}
                onClick={() => props.onChoose(item)}
              >
                {each.type === "spade-bot" ? (
                  <BotPicture face={face} size={96} />
                ) : (
                  <Stage entry={keyOf(item)} size="card" />
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

/** What a bot's recipe holds, as publishing it sends it. */
export function RecipePreview(props: {
  recipe: Recipe | undefined;
  leftOut: readonly string[];
  failed: string | undefined;
}) {
  const { recipe } = props;
  if (props.failed)
    return (
      <p className="mk-withdrawn-line" style={{ marginTop: 32 }}>
        {props.failed}
      </p>
    );
  if (!recipe)
    return (
      <p className="mk-line" style={{ marginTop: 32 }}>
        Reading its recipe…
      </p>
    );
  const skills = recipe.skills.map(refName);
  const plugins = recipe.plugins.map(refName);
  return (
    <section aria-label="Its recipe" style={{ marginTop: 32, maxWidth: 640 }}>
      <h2 className="mk-quiet-head">What its recipe holds</h2>
      <dl className="mk-facts">
        <div className="mk-fact">
          <dt>Model</dt>
          <dd>{recipe.model === "fast" ? "Fast" : "Capable"}, on each person's own model</dd>
        </div>
        {skills.length > 0 && (
          <div className="mk-fact">
            <dt>Skills</dt>
            <dd>{skills.join(", ")}</dd>
          </div>
        )}
        {plugins.length > 0 && (
          <div className="mk-fact">
            <dt>Plugins</dt>
            <dd>{plugins.join(", ")}</dd>
          </div>
        )}
        {recipe.needs.tools && (
          <div className="mk-fact">
            <dt>Tools</dt>
            <dd>{recipe.needs.tools.join(", ")}</dd>
          </div>
        )}
      </dl>
      <h3 className="mk-quiet-head">Routines</h3>
      {recipe.routines.length === 0 ? (
        <p className="mk-line">None.</p>
      ) : (
        <ul aria-label="Routines" style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {recipe.routines.map((routine) => (
            <li key={routine.name} className="mk-fact-row">
              <span className="mk-words">
                <span className="mk-name">{routine.name}</span>
                <span className="mk-meta">{routine.schedule}</span>
              </span>
              <span className="mk-state-word">Starts paused</span>
            </li>
          ))}
        </ul>
      )}
      <h3 className="mk-quiet-head">What it asks for</h3>
      {recipe.needs.connectors.length === 0 ? (
        <p className="mk-line">No apps.</p>
      ) : (
        <ul aria-label="What it asks for" style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {recipe.needs.connectors.map((need) => (
            <li key={needLabel(need)} className="mk-fact-row">
              <span className="mk-words">
                <span className="mk-name">{needLabel(need)}</span>
                <span className="mk-meta">{need.why}</span>
              </span>
              <span className="mk-state-word">{need.required ? "Required" : "Optional"}</span>
            </li>
          ))}
        </ul>
      )}
      {props.leftOut.length > 0 && (
        <>
          <h3 className="mk-quiet-head">Left out</h3>
          {props.leftOut.map((line) => (
            <p key={line} className="mk-line">
              {line}
            </p>
          ))}
        </>
      )}
      <p className="mk-line" style={{ marginTop: 16 }}>
        Its keys, tokens, notes and the access you gave it stay on this machine.
      </p>
    </section>
  );
}
