import type { MarketReviewBody } from "@ace/protocol/marketplace";
import { Switch } from "@/components/ui/switch.tsx";
import { part } from "@/lib/suit-part.ts";
import { effectStartsOn, updateSentences } from "@ace/ui-core/spade-chat";
import { codeKey, decidedEachTime, effectWords, triggerWhen } from "./market-package-words.ts";
import { needCatalogue } from "./market-model.ts";
import { AppMark } from "@/components/ui/app-mark.tsx";
import { ReplayLine } from "@/features/spade/index.ts";

/*
 * A bot's part of its review (ADR 0168 §8, ADR 0200 §3.4, §6.1). For an install: what it may do,
 * each declared effect a row with its reason and a switch (nothing is granted until Install, and
 * a send, a payment or an access change still comes to the person each time; from anyone but ace
 * only its declared hosts start on, `effectStartsOn`); its apps as
 * switches; its routines and other triggers, paused unless Start its routines is on. For an
 * update or a rollback: what changes, what stays because the person changed it, what it asks
 * for that starts off, and how the bot's kept runs replay on the new version (ADR 0204 §2).
 */

type Recipe = Extract<MarketReviewBody, { type: "spade-bot" }>;

function Head(props: { children: string }) {
  return (
    <h3 {...part("section-title", undefined, "quiet")} className="mk-quiet-head">
      {props.children}
    </h3>
  );
}

function Sentences(props: { label: string; lines: readonly string[] }) {
  if (!props.lines.length) return null;
  return (
    <>
      <Head>{props.label}</Head>
      <ul className="mk-review-facts" aria-label={props.label}>
        {props.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </>
  );
}

/** An update's or rollback's own section: what changes, what stays, what asks for more. */
export function UpdateChoices(props: { recipe: Recipe }) {
  const update = props.recipe.update;
  if (!update) return null;
  const words = updateSentences(update, props.recipe.effects ?? []);
  return (
    <>
      <Sentences label="What changes" lines={words.changes} />
      <Sentences label="Stays because you changed it" lines={words.kept} />
      <Sentences label="Asks for more" lines={words.more} />
      {update.replay && update.replay.cases.length > 0 && (
        <>
          <Head>Your kept runs</Head>
          <ReplayLine replay={update.replay} />
        </>
      )}
    </>
  );
}

/**
 * What it may do: each declared effect as a switch, as `effectDefaults` started it. When a
 * stranger's package starts some off, one sentence says so.
 */
function EffectChoices(props: {
  recipe: Recipe;
  byAce: boolean;
  effects: Readonly<Record<string, boolean>>;
  onEffects(next: (before: Record<string, boolean>) => Record<string, boolean>): void;
}) {
  const rows = props.recipe.effects ?? [];
  if (!rows.length) return null;
  return (
    <>
      <Head>What it may do</Head>
      {!props.byAce && rows.some((row) => !effectStartsOn(row, false)) && (
        <p className="mk-meta">
          It isn't made by ace, so only reaching the sites it names starts on. Turn on what you want
          it to do.
        </p>
      )}
      {rows.map((row) => {
        const words = effectWords(row);
        return (
          <div key={row.key} className="mk-fact-row">
            <span className="mk-words">
              <span className="mk-name">{words}</span>
              <span className="mk-meta">
                {row.why}
                {decidedEachTime(row) ? " You decide each time." : ""}
              </span>
            </span>
            <Switch
              aria-label={words}
              checked={props.effects[row.key] === true}
              onCheckedChange={(on) => props.onEffects((before) => ({ ...before, [row.key]: on }))}
            />
          </div>
        );
      })}
    </>
  );
}

/**
 * Its own code (ADR 0203 §5): each component a row with the sentence its binary's imports make,
 * why it is there, and a switch that starts on; one turned off doesn't run.
 */
function CodeChoices(props: {
  recipe: Recipe;
  effects: Readonly<Record<string, boolean>>;
  onEffects(next: (before: Record<string, boolean>) => Record<string, boolean>): void;
}) {
  const rows = props.recipe.code ?? [];
  if (!rows.length) return null;
  return (
    <>
      <Head>Runs its own code</Head>
      {rows.map((row) => {
        const key = codeKey(row.name);
        return (
          <div key={key} className="mk-fact-row">
            <span className="mk-words">
              <span className="mk-name">{row.sentence}</span>
              <span className="mk-meta">{row.why}</span>
            </span>
            <Switch
              aria-label={`Run ${row.name}`}
              checked={props.effects[key] !== false}
              onCheckedChange={(on) => props.onEffects((before) => ({ ...before, [key]: on }))}
            />
          </div>
        );
      })}
    </>
  );
}

/** A recipe's or package's choices on its install review. */
export function RecipeChoices(props: {
  recipe: Recipe;
  byAce: boolean;
  needs: Readonly<Record<string, boolean>>;
  onNeeds(next: (before: Record<string, boolean>) => Record<string, boolean>): void;
  effects: Readonly<Record<string, boolean>>;
  onEffects(next: (before: Record<string, boolean>) => Record<string, boolean>): void;
  start: boolean;
  onStart(start: boolean): void;
}) {
  const { recipe } = props;
  if (recipe.update) return <UpdateChoices recipe={recipe} />;
  const triggered = (recipe.triggers ?? []).flatMap((trigger) => {
    const when = triggerWhen(trigger);
    return when && "name" in trigger ? [{ name: trigger.name, when }] : [];
  });
  const routines = [
    ...recipe.routines.map((routine) => ({ name: routine.name, when: routine.schedule })),
    ...triggered,
  ];
  return (
    <>
      {recipe.modelWarning && (
        <p role="note" className="mk-withdrawn-line">
          {recipe.modelWarning}
        </p>
      )}
      <EffectChoices
        recipe={recipe}
        byAce={props.byAce}
        effects={props.effects}
        onEffects={props.onEffects}
      />
      <CodeChoices recipe={recipe} effects={props.effects} onEffects={props.onEffects} />
      {recipe.needs.length > 0 && (
        <>
          <Head>Apps</Head>
          {recipe.needs.map((need) => (
            <div key={need.key} className="mk-fact-row">
              <AppMark catalogue={needCatalogue(need.key)} name={need.label} size="fact" />
              <span className="mk-words">
                <span className="mk-name">{need.label}</span>
                <span className="mk-meta">
                  {need.why} {need.required ? "Required." : "Optional."}
                </span>
              </span>
              <Switch
                aria-label={need.label}
                checked={props.needs[need.key] === true}
                onCheckedChange={(on) => props.onNeeds((before) => ({ ...before, [need.key]: on }))}
              />
            </div>
          ))}
        </>
      )}
      {routines.length > 0 && (
        <>
          <Head>Routines</Head>
          {routines.map((routine) => (
            <div key={routine.name} className="mk-fact-row">
              <span className="mk-words">
                <span className="mk-name">{routine.name}</span>
                <span className="mk-meta">{routine.when}</span>
              </span>
            </div>
          ))}
          <div className="mk-fact-row">
            <span className="mk-words">
              <span className="mk-name">Start its routines</span>
            </span>
            <Switch
              aria-label="Start its routines"
              checked={props.start}
              onCheckedChange={props.onStart}
            />
          </div>
        </>
      )}
    </>
  );
}
