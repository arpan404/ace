// oxlint-disable react/no-array-index-key -- footnotes have no identity beyond their order.
import {
  ArrowBendLeftUpIcon,
  ChatCenteredTextIcon,
  InfoIcon,
  LightbulbIcon,
  WarningIcon,
  WarningOctagonIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { Token, Tokens } from "marked";
import { useContext, useState, type ReactNode } from "react";
import { blockRhythm } from "@/components/markdown/rhythm.ts";
import { cn } from "@/lib/cn.ts";
import { ForgeDocument, ForgeText, scrollToAnchor } from "./forge-text.tsx";
import { withTask } from "./source-marks.ts";

/*
 * Block-level pieces of GitHub's markdown that agent prose doesn't have (ADR 0096): alerts
 * (`> [!NOTE]`), task boxes that tick through the forge's guarded edit, and footnotes. Alerts
 * stay monochrome: colour in ace means an agent's state (DESIGN.md), so the kind reads from its
 * icon and word.
 */

const alerts: Record<string, { label: string; icon: Icon }> = {
  NOTE: { label: "Note", icon: InfoIcon },
  TIP: { label: "Tip", icon: LightbulbIcon },
  IMPORTANT: { label: "Important", icon: ChatCenteredTextIcon },
  WARNING: { label: "Warning", icon: WarningIcon },
  CAUTION: { label: "Caution", icon: WarningOctagonIcon },
};
const alertMarker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

/** A blockquote that opens with `[!NOTE]` (and the like): its kind and its tokens without it. */
export function alertOf(
  token: Tokens.Blockquote,
): { kind: string; tokens: readonly Token[] } | undefined {
  const first = token.tokens[0];
  if (first?.type !== "paragraph" || !("tokens" in first)) return undefined;
  const paragraph = first as Tokens.Paragraph;
  const match = alertMarker.exec(paragraph.raw);
  const kind = match?.[1]?.toUpperCase();
  if (!match || !kind) return undefined;
  // The marker sits at the start of the paragraph's first text token: cut it from there.
  const [lead, ...rest] = paragraph.tokens;
  const inline: Token[] = [...rest];
  if (lead && lead.type === "text") {
    const remaining = lead.raw.replace(alertMarker, "");
    if (remaining)
      inline.unshift({ ...lead, raw: remaining, text: remaining, tokens: undefined } as Token);
  } else if (lead) inline.unshift(lead);
  const remainder = paragraph.raw.replace(alertMarker, "");
  const tokens: Token[] = token.tokens.slice(1);
  if (remainder.trim())
    tokens.unshift({ ...paragraph, raw: remainder, text: remainder, tokens: inline });
  return { kind, tokens };
}

export function Alert(props: { kind: string; children: ReactNode }) {
  const alert = alerts[props.kind] ?? alerts.NOTE;
  if (!alert) return null;
  const Glyph = alert.icon;
  return (
    <div role="note" className="border-l-2 border-border-strong pl-3">
      <p className="flex items-center gap-1.5 font-medium text-foreground">
        <Glyph aria-hidden size={16} className="shrink-0" />
        {alert.label}
      </p>
      <div className={cn("mt-1", blockRhythm)}>{props.children}</div>
    </div>
  );
}

/** The task boxes of one document: where each box's text is, and how a tick is saved. */
export interface TaskControl {
  source: string;
  /** Saves `next` as the text through the forge's guarded edit; resolves whether it took. */
  change(next: string): Promise<boolean>;
}

/**
 * A task box. With `control` it ticks: the text is saved with only this box's mark changed,
 * showing the new state while it saves and going back if the forge refuses. Without it, or when
 * the boxes on the page can't be matched to the text, it only shows its state.
 */
export function TaskBox(props: {
  checked: boolean;
  index: number | undefined;
  drawn: number;
  control: TaskControl | undefined;
}) {
  const [saving, setSaving] = useState<{ from: boolean; to: boolean }>();
  const checked = saving && saving.from === props.checked ? saving.to : props.checked;
  const next =
    props.control && props.index !== undefined
      ? withTask(props.control.source, props.index, !checked, props.drawn)
      : undefined;
  const label = checked ? "Done" : "Not done";
  if (!props.control || next === undefined)
    return (
      <input
        type="checkbox"
        checked={checked}
        readOnly
        aria-label={label}
        className="mr-1.5 align-[-1px]"
      />
    );
  const control = props.control;
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      disabled={saving !== undefined && saving.from === props.checked}
      onChange={() => {
        setSaving({ from: props.checked, to: !checked });
        void control.change(next).then((ok) => {
          if (!ok) setSaving(undefined);
        });
      }}
      className="mr-1.5 cursor-pointer align-[-1px] disabled:cursor-default"
    />
  );
}

const definition = /^ {0,3}\[\^([^\]\s]{1,64})\]:[ \t]?/;

/** A paragraph or link definition that defines footnote `label`, with the label. */
export function footnoteLabel(token: Token): string | undefined {
  if (token.type !== "paragraph" && token.type !== "def") return undefined;
  return definition.exec(token.raw)?.[1];
}

/** The footnotes a document defines, in order, as a numbered list after its last block. */
export function Footnotes(props: {
  tokens: readonly Token[];
  inline(tokens: readonly Token[]): ReactNode;
}) {
  const doc = useContext(ForgeDocument);
  const notes = props.tokens.flatMap((token) => {
    const label = footnoteLabel(token);
    if (label === undefined || !doc.footnotes.has(label)) return [];
    let body: ReactNode;
    if (token.type === "paragraph" && "tokens" in token) {
      const [lead, ...rest] = (token as Tokens.Paragraph).tokens;
      const inline: Token[] = [...rest];
      if (lead?.type === "text") {
        const text = lead.raw.replace(definition, "");
        if (text) inline.unshift({ ...lead, raw: text, text, tokens: undefined } as Token);
      } else if (lead) inline.unshift(lead);
      body = props.inline(inline);
    } else body = <ForgeText text={token.raw.replace(definition, "").trim()} />;
    return [{ label, body }];
  });
  if (!notes.length) return null;
  return (
    <section aria-label="Footnotes" className="border-t pt-3 text-xs text-muted-foreground">
      <ol className="list-decimal pl-5 marker:text-subtle-foreground [&>li+li]:mt-1">
        {notes.map((note, index) => (
          <li key={index} id={`${doc.anchor}fn-${note.label}`}>
            {note.body}{" "}
            <a
              href={`#${doc.anchor}fnref-${note.label}`}
              aria-label="Back to the text"
              onClick={(event) => scrollToAnchor(event, `${doc.anchor}fnref-${note.label}`)}
              className="inline-flex align-middle text-link focus-ring"
            >
              <ArrowBendLeftUpIcon aria-hidden size={12} />
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
