import type { MarketReview, MarketReviewBody, MarketReviewItem } from "@ace/protocol/marketplace";
import { SuitManifest, type SuitDetail } from "@ace/protocol/suits";
import { parseStoredBotFace } from "@ace/ui-core/bot-face";
import type { ReactNode } from "react";
import { BotFace } from "@/components/bot-face.tsx";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { AppPreview } from "@/features/settings/index.ts";
import { part } from "@/lib/suit-part.ts";
import { sizeText, typeWord } from "./market-model.ts";

/*
 * What an entry brings, from its review: a Suit's look, a recipe's bot, and the files, texts,
 * changes and commands of its pages. Drawn on the entry page and again on the review.
 */

type Recipe = Extract<MarketReviewBody, { type: "spade-bot" }>;

/** The Suit's `suit.json` from its review, as the library would read it; undefined if it isn't one. */
export function suitFromReview(review: MarketReview, items: readonly MarketReviewItem[]) {
  const text = items.find(
    (item) => item.kind === "text" && item.path === "suit.json" && !item.before,
  );
  if (text?.kind !== "text" || review.type !== "suit") return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text.text);
  } catch {
    return undefined;
  }
  const manifest = SuitManifest.safeParse(raw);
  if (!manifest.success) return undefined;
  const detail: SuitDetail = {
    summary: {
      id: manifest.data.id,
      name: manifest.data.name,
      description: manifest.data.description,
      schemes: [manifest.data.light && "light", manifest.data.dark && "dark"].filter(
        (scheme): scheme is "light" | "dark" => !!scheme,
      ),
      scene: false,
      contentHash: review.hash,
      problems: [],
    },
    manifest: manifest.data,
    sceneUrl: null,
    sceneUrls: {},
    assets: {},
    css: null,
    ornaments: {},
  };
  return detail;
}

/** The Suit as Appearance previews looks: the window in miniature, light and dark. */
export function SuitLook(props: { suit: SuitDetail }) {
  return (
    <div {...part("card", undefined, "look-preview")} className="mt-6 max-w-md">
      <AppPreview look={{ suit: props.suit }} scheme="split" className="aspect-[16/9]" />
    </div>
  );
}

/** A recipe's bot: its face and name, its task in full, its model kind, routines and what it brings. */
export function RecipeFacts(props: { body: Recipe; children?: ReactNode }) {
  const { body } = props;
  const face = parseStoredBotFace(body.face)?.face;
  return (
    <>
      <div className="mt-6 flex items-center gap-3">
        {face && <BotFace face={face} size={48} />}
        <span className="text-md font-medium text-foreground">{body.botName}</span>
      </div>
      <SettingSection label="Task">
        <SettingRow
          title={body.model === "fast" ? "Runs on your fast model" : "Runs on your capable model"}
          description={<span className="whitespace-pre-wrap">{body.task}</span>}
        />
      </SettingSection>
      {props.children}
      {body.brings.length > 0 && (
        <SettingSection label="Brings">
          {body.brings.map((entry) => (
            <SettingRow
              key={`${entry.type}/${entry.name}`}
              title={entry.name}
              description={`${typeWord(entry.type)} · Version ${entry.version}`}
            />
          ))}
        </SettingSection>
      )}
      {body.notes.length > 0 && (
        <SettingSection label="Notes">
          {body.notes.map((note) => (
            <SettingRow key={note} title={note} />
          ))}
        </SettingSection>
      )}
    </>
  );
}

/** A recipe's routines with their schedules, read only (the review adds its switch). */
export function RoutineRows(props: { body: Recipe }) {
  return props.body.routines.map((routine) => (
    <SettingRow
      key={routine.name}
      title={`${routine.name} · ${routine.schedule}`}
      description={routine.instruction}
    />
  ));
}

/** A recipe's needs as rows, read only: what each is and why the bot wants it. */
export function NeedRows(props: { body: Recipe }) {
  return props.body.needs.map((need) => (
    <SettingRow
      key={need.key}
      title={need.label}
      description={`${need.why} ${need.required ? "Required." : "Optional."}`}
    />
  ));
}

const changeWords = { added: "Added", changed: "Changed", removed: "Removed" } as const;

/** The review's pages: files, texts, what changed in an update, and the commands it runs. */
export function ReviewItems(props: { items: readonly MarketReviewItem[] }) {
  const files = props.items.filter((item) => item.kind === "file");
  const changes = props.items.filter((item) => item.kind === "change");
  const texts = props.items.filter((item) => item.kind === "text");
  const runs = props.items.filter((item) => item.kind === "execution");
  const notes = props.items.filter((item) => item.kind === "note");
  return (
    <>
      {changes.length > 0 && (
        <SettingSection label="What changed">
          {changes.map((item) => (
            <SettingRow
              key={`${item.section}/${item.path}`}
              title={`${changeWords[item.change]} ${item.path}`}
              description={item.executable ? "A script or program." : undefined}
            />
          ))}
        </SettingSection>
      )}
      {runs.length > 0 && (
        <SettingSection label="What it runs">
          {runs.map((item) => (
            <SettingRow
              key={`${item.section}/${runTitle(item.execution)}/${runDetail(item.execution)}`}
              title={runTitle(item.execution)}
              description={<code className="break-all">{runDetail(item.execution)}</code>}
            />
          ))}
        </SettingSection>
      )}
      {texts.map((item) => (
        <SettingSection
          key={`${item.section}/${item.path}/${item.before}`}
          label={item.before ? `${item.path} before` : item.path}
        >
          <pre className="max-h-80 overflow-auto px-4 py-3 font-mono text-sm whitespace-pre-wrap text-muted-foreground">
            {item.text}
          </pre>
        </SettingSection>
      ))}
      {files.length > 0 && (
        <SettingSection label="Files">
          {files.map((item) => (
            <SettingRow
              key={`${item.section}/${item.file.path}`}
              density="compact"
              title={<span className="font-mono text-sm">{item.file.path}</span>}
              description={`${sizeText(item.file.bytes)}${item.file.flagged ? " · A script or program" : ""}`}
            />
          ))}
        </SettingSection>
      )}
      {notes.map((item) => (
        <p key={`${item.section}/${item.text}`} className="mt-4 text-ui text-muted-foreground">
          {item.text}
        </p>
      ))}
    </>
  );
}

type Execution = Extract<MarketReviewItem, { kind: "execution" }>["execution"];

function runTitle(execution: Execution): string {
  switch (execution.kind) {
    case "hook":
      return `Hook on ${execution.event}`;
    case "stdio":
      return `Server ${execution.name}`;
    case "remote":
      return `Remote server ${execution.name}`;
  }
}

function runDetail(execution: Execution): string {
  switch (execution.kind) {
    case "hook":
      return execution.command;
    case "stdio":
      return [execution.command, ...execution.args].join(" ");
    case "remote":
      return execution.url;
  }
}
