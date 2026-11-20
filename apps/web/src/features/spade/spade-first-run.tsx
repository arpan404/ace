import {
  spadeAboutYouNotes,
  spadeAboutYouQuestions,
  spadeModelState,
  type SpadeAboutYouField,
  type SpadeAgent,
} from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { BotFace } from "@/components/bot-face.tsx";
import { Input } from "@/components/ui/input.tsx";
import { cn } from "@/lib/cn.ts";
import { createAgent } from "./spade-api.ts";
import {
  CardBody,
  CardFooter,
  CardPrimary,
  CardWord,
  NeedsYouLine,
  RaisedCard,
} from "./spade-card.tsx";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { addNote, notesKey } from "./spade-notes-api.ts";
import { rowPill } from "./spade-profile-parts.tsx";
import { readOnboarding, setOnboarding } from "./spade-provenance-api.ts";
import { personZone } from "./spade-routines-api.ts";
import { readTemplates } from "./spade-teams-api.ts";
import { useSpadeModels } from "./use-spade-models.ts";
import { agentsKey } from "./use-spade-roster.ts";
import { Button } from "@/components/ui/button.tsx";

/** First run's read; one machine's under `[...onboardingKey, machine]`. */
export const onboardingKey = ["spade", "onboarding"] as const;

/**
 * First run, at the foot of the main Spade's chat (spade/docs/memory.md, About you): once Spade
 * is on and has a model, a short About-you interview whose answers become the shared notes every
 * bot sees (skippable, each question too, and edited later in Library › About you), then the
 * starter bots from the templates, each made in one click. Done or skipped, Spade remembers.
 */
export function SpadeFirstRun(props: { main: SpadeAgent }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const models = useSpadeModels(true);
  const step = useQuery({
    queryKey: [...onboardingKey, machine],
    queryFn: ({ signal }) => readOnboarding(client, signal),
    retry: false,
  });
  const cache = useQueryClient();
  const data = models.data;
  // Not before Spade has a model to talk with.
  if (!data || spadeModelState(props.main.model, data.endpoints) === "none") return null;
  if (!step.data) return null;
  const mark = async (change: Parameters<typeof setOnboarding>[1]) => {
    await setOnboarding(client, change);
    await cache.invalidateQueries({ queryKey: [...onboardingKey, machine] });
  };
  if (step.data.aboutYou === undefined) return <AboutYou onDone={mark} />;
  if (step.data.starters === undefined) return <Starters onDone={mark} />;
  return null;
}

type Mark = (change: Parameters<typeof setOnboarding>[1]) => Promise<void>;

/** The interview: one question at a time, each optional, its answers kept as About-you notes. */
function AboutYou(props: { onDone: Mark }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const fieldId = useId();
  const [at, setAt] = useState(0);
  const [answers, setAnswers] = useState<Partial<Record<SpadeAboutYouField, string>>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const question = spadeAboutYouQuestions[at];
  if (!question) return null;
  const last = at === spadeAboutYouQuestions.length - 1;
  const answer = answers[question.field] ?? "";
  const set = (value: string) => setAnswers((now) => ({ ...now, [question.field]: value }));
  const finish = async (all: typeof answers) => {
    setSaving(true);
    setProblem(undefined);
    try {
      for (const text of spadeAboutYouNotes(all)) await addNote(client, { kind: "shared" }, text);
      await cache.invalidateQueries({ queryKey: notesKey });
      await props.onDone({ about_you: "done" });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Try again.");
    } finally {
      setSaving(false);
    }
  };
  const next = () => (last ? void finish(answers) : setAt(at + 1));
  return (
    <RaisedCard asks="question" aria-label="About you">
      <NeedsYouLine
        glyph="question"
        aside={
          <span className="text-xs text-subtle-foreground tabular-nums">
            {at + 1}/{spadeAboutYouQuestions.length}
          </span>
        }
      >
        {at === 0 && (
          <p className="text-muted-foreground">
            A few things about you, so every bot starts knowing them. Skip any.
          </p>
        )}
        <label htmlFor={fieldId}>{question.ask}</label>
      </NeedsYouLine>
      <CardBody>
        <Input
          id={fieldId}
          value={answer}
          placeholder={question.placeholder}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the card asks this now.
          autoFocus
          onChange={(event) => set(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              next();
            }
          }}
          className="bg-chat-well"
        />
        {question.picks.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {question.picks.map((pick) => (
              <Button
                key={pick}
                variant="ghost"
                aria-pressed={answer === pick}
                onClick={() => set(pick)}
                className={cn(rowPill, "bg-chat-well", answer === pick && "bg-active")}
              >
                {pick}
              </Button>
            ))}
          </div>
        )}
        {problem && <p className="mt-2 text-ui text-destructive">{problem}</p>}
      </CardBody>
      <CardFooter
        start={
          <CardWord disabled={saving} onClick={() => void props.onDone({ about_you: "skipped" })}>
            Skip for now
          </CardWord>
        }
        end={
          <CardPrimary disabled={saving} onClick={next}>
            {last ? (saving ? "Saving…" : "Done") : answer.trim() ? "Next" : "Skip this one"}
          </CardPrimary>
        }
      />
    </RaisedCard>
  );
}

/** The starter bots: each template with Create, made in one click; Done when the person is. */
function Starters(props: { onDone: Mark }) {
  const client = useSpadeClient();
  const machine = useSpadeMachine().key;
  const cache = useQueryClient();
  const templates = useQuery({
    queryKey: ["spade", "templates", machine],
    queryFn: ({ signal }) => readTemplates(client, { signal }),
  });
  const [made, setMade] = useState<ReadonlySet<string>>(new Set());
  const [making, setMaking] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const list = templates.data ?? [];
  if (!list.length) return null;
  const create = async (template: string) => {
    setMaking(template);
    setProblem(undefined);
    try {
      await createAgent(client, { name: "", task: "", template, time_zone: personZone() });
      setMade((now) => new Set([...now, template]));
      await cache.invalidateQueries({ queryKey: agentsKey });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Try again.");
    } finally {
      setMaking(undefined);
    }
  };
  return (
    <RaisedCard asks="question" aria-label="Starter bots">
      <NeedsYouLine glyph="question">
        <p>Want a few bots to start with? Each one is ready to talk to.</p>
      </NeedsYouLine>
      <CardBody>
        <ul className="-mx-2 flex flex-col">
          {list.map((template) => (
            <li key={template.id} className="flex min-h-12 items-center gap-3 rounded-xl px-2">
              <BotFace face={template.face} size={32} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui font-medium">{template.name}</span>
                {template.blurb && (
                  <span className="truncate text-xs text-muted-foreground">{template.blurb}</span>
                )}
              </span>
              {made.has(template.id) ? (
                <span className="px-3 text-ui text-muted-foreground">Created</span>
              ) : (
                <Button
                  variant="secondary"
                  aria-label={`Create ${template.name}`}
                  disabled={making !== undefined}
                  onClick={() => void create(template.id)}
                  className={rowPill}
                >
                  {making === template.id ? "Creating…" : "Create"}
                </Button>
              )}
            </li>
          ))}
        </ul>
        {problem && <p className="mt-2 text-ui text-destructive">{problem}</p>}
      </CardBody>
      <CardFooter
        start={
          made.size === 0 && (
            <CardWord onClick={() => void props.onDone({ starters: "skipped" })}>Not now</CardWord>
          )
        }
        end={
          made.size > 0 && (
            <CardPrimary onClick={() => void props.onDone({ starters: "done" })}>Done</CardPrimary>
          )
        }
      />
    </RaisedCard>
  );
}
