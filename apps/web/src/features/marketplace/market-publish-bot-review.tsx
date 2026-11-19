import type {
  MarketBotReview,
  MarketDraftChecked,
  MarketPrivacySpan,
} from "@ace/protocol/marketplace";
import { useState } from "react";
import { needLabel, refName } from "./market-publish-pick.ts";
import { acceptedTexts, usePrivacy, useReport } from "./market-publish-review.ts";
import { part } from "@/lib/suit-part.ts";

/*
 * A bot's recipe before it is published (ADR 0174 §2): what it holds, the task to edit or
 * confirm, and its routines, each left out until the person includes it, then edited or
 * confirmed. Every flagged span is shown under its text; a secret can't be confirmed. The
 * privacy pass runs again in the daemon on the words sent.
 */

interface RoutineState {
  include: boolean;
  instruction: string;
  ok: boolean;
}

const listStyle = { margin: 0, padding: 0, listStyle: "none" } as const;

function Flags(props: { spans: readonly MarketPrivacySpan[] | undefined }) {
  if (!props.spans?.length) return null;
  return (
    <>
      {props.spans.map((span) => (
        <p
          key={`${span.kind}:${span.start}:${span.text}`}
          className={span.kind === "secret" ? "mk-withdrawn-line" : "mk-line"}
        >
          {span.sentence}
        </p>
      ))}
    </>
  );
}

const hasSecret = (spans: readonly MarketPrivacySpan[] | undefined) =>
  spans?.some((span) => span.kind === "secret") ?? false;

function Confirm(props: {
  label: string;
  checked: boolean;
  blocked: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <label className="mk-line">
      <input
        type="checkbox"
        aria-label={props.label}
        checked={props.checked}
        disabled={props.blocked}
        onChange={(event) => props.onChange(event.target.checked)}
      />{" "}
      {props.label}
    </label>
  );
}

export function BotReview(props: {
  review: MarketBotReview;
  hash: string;
  onChecked(checked: MarketDraftChecked | undefined): void;
}) {
  const { recipe, leftOut } = props.review;
  const [task, setTask] = useState(recipe.task);
  const [taskOk, setTaskOk] = useState(false);
  const [routines, setRoutines] = useState<RoutineState[]>(() =>
    recipe.routines.map((routine) => ({
      include: false,
      instruction: routine.instruction,
      ok: false,
    })),
  );
  const included = recipe.routines
    .map((routine, at) => ({ ...routine, ...(routines[at] ?? { include: false, ok: false }) }))
    .filter((routine) => routine.include);
  const texts = [
    recipe.name,
    task,
    ...included.flatMap((routine) => [routine.name, routine.instruction]),
  ];
  const privacy = usePrivacy(texts);
  const spansOf = (at: number) => privacy?.[at];
  const spansFor = (routine: number) => {
    const at = included.findIndex((each) => each.name === recipe.routines[routine]?.name);
    return at < 0 ? undefined : [...(spansOf(2 + at * 2) ?? []), ...(spansOf(3 + at * 2) ?? [])];
  };
  const blocked = privacy?.some((spans) => hasSecret(spans)) ?? true;
  const ready = privacy !== undefined && !blocked && taskOk && included.every((each) => each.ok);
  const { onChecked, hash } = props;
  const checked: MarketDraftChecked | undefined = ready
    ? {
        hash,
        binaries: [],
        accepted: acceptedTexts(privacy),
        recipe: {
          task,
          routines: included.map((each) => ({
            name: each.name,
            instruction: each.instruction,
            schedule: each.schedule,
          })),
        },
      }
    : undefined;
  useReport(checked, onChecked);
  const setRoutine = (at: number, change: Partial<RoutineState>) =>
    setRoutines((before) =>
      before.map((each, index) => (index === at ? { ...each, ...change } : each)),
    );
  const skills = recipe.skills.map(refName);
  const plugins = recipe.plugins.map(refName);
  return (
    <section aria-label="Its recipe" style={{ marginTop: 32, maxWidth: 640 }}>
      <h2 {...part("section-title", undefined, "quiet")} className="mk-quiet-head">
        What its recipe holds
      </h2>
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
      <Flags spans={spansOf(0)} />
      <h3 {...part("section-title", undefined, "quiet")} className="mk-quiet-head">
        The task
      </h3>
      <textarea
        className="mk-field"
        aria-label="Task"
        rows={4}
        value={task}
        onChange={(event) => {
          setTask(event.target.value);
          setTaskOk(false);
        }}
      />
      <Flags spans={spansOf(1)} />
      <Confirm
        label="The task is ready to publish"
        checked={taskOk}
        blocked={hasSecret(spansOf(1)) || hasSecret(spansOf(0))}
        onChange={setTaskOk}
      />
      <h3 {...part("section-title", undefined, "quiet")} className="mk-quiet-head">
        Routines
      </h3>
      {recipe.routines.length === 0 ? (
        <p className="mk-line">None.</p>
      ) : (
        <ul aria-label="Routines" style={listStyle}>
          {recipe.routines.map((routine, at) => {
            const state = routines[at];
            return (
              <li key={routine.name} className="mk-fact-row" style={{ display: "block" }}>
                <label className="mk-words">
                  <span className="mk-name">
                    <input
                      type="checkbox"
                      aria-label={`Include ${routine.name}`}
                      checked={state?.include ?? false}
                      onChange={(event) =>
                        setRoutine(at, { include: event.target.checked, ok: false })
                      }
                    />{" "}
                    {routine.name}
                  </span>
                  <span className="mk-meta">{routine.schedule}, starts paused</span>
                </label>
                {state?.include && (
                  <>
                    <textarea
                      className="mk-field"
                      aria-label={`Instruction for ${routine.name}`}
                      rows={3}
                      value={state.instruction}
                      onChange={(event) =>
                        setRoutine(at, { instruction: event.target.value, ok: false })
                      }
                    />
                    <Flags spans={spansFor(at)} />
                    <Confirm
                      label={`${routine.name} is ready to publish`}
                      checked={state.ok}
                      blocked={hasSecret(spansFor(at))}
                      onChange={(ok) => setRoutine(at, { ok })}
                    />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <h3 {...part("section-title", undefined, "quiet")} className="mk-quiet-head">
        What it asks for
      </h3>
      {recipe.needs.connectors.length === 0 ? (
        <p className="mk-line">No apps.</p>
      ) : (
        <ul aria-label="What it asks for" style={listStyle}>
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
      {leftOut.length > 0 && (
        <>
          <h3 {...part("section-title", undefined, "quiet")} className="mk-quiet-head">
            Left out
          </h3>
          {leftOut.map((line) => (
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
