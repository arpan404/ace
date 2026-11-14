import type { SuitProblem, SuitSummary } from "@ace/protocol/suits";
import { themes, type Scheme } from "@ace/themes";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { suitReady } from "@/theme/suits/applied-suit.ts";
import { suitPalette } from "@/theme/suits/suit-css.ts";
import { useSuitDetail, useSuitLibrary } from "@/theme/suits/suit-library.tsx";
import { useTheme } from "@/theme/theme-provider.tsx";
import { settingRow } from "./settings-index.ts";

/*
 * Settings > Appearance > Suits (ADR 0150): the looks agents made, from the daemon's library.
 * A Suit that passes every check can be used on this device; one that doesn't says what needs
 * fixing, and can't be used until an agent fixes it.
 */

const schemeWords = (schemes: readonly Scheme[]) =>
  schemes.length === 2 ? "Light and dark" : schemes[0] === "light" ? "Light only" : "Dark only";

/** Page, sidebar, accent and text of the Suit in the scheme on screen. Decoration only. */
function Swatch(props: { summary: SuitSummary; scheme: Scheme }) {
  const detail = useSuitDetail(props.summary);
  const palette = detail ? suitPalette(detail.manifest, props.scheme) : undefined;
  const colours: [string, string][] = palette
    ? [
        ["page", palette.s0],
        ["sidebar", palette.sidebar],
        ["accent", palette.accent],
        ["text", palette.t1],
      ]
    : ["page", "sidebar", "accent", "text"].map((part) => [part, "var(--skel)"]);
  return (
    <span
      aria-hidden
      data-testid="suit-swatch"
      className="flex h-4 w-12 shrink-0 overflow-hidden rounded-xs shadow-[0_0_0_1px_var(--border)]"
    >
      {colours.map(([part, colour]) => (
        <span key={part} className="flex-1" style={{ background: colour }} />
      ))}
    </span>
  );
}

function problemText(problem: SuitProblem): string {
  const where = [problem.scheme, problem.field].filter(Boolean).join(" ");
  return where ? `${problem.message} (${where})` : problem.message;
}

function SuitRow(props: { summary: SuitSummary }) {
  const { summary } = props;
  const { appearance, update, resolved, suitsOff } = useTheme();
  const picked = appearance.suit === summary.id;
  const ready = suitReady(summary);
  const facts = [schemeWords(summary.schemes), summary.scene ? "Has a scene" : undefined]
    .filter(Boolean)
    .join(" · ");
  return (
    <SettingRow
      title={
        <span className="flex items-center gap-2">
          <Swatch summary={summary} scheme={resolved.scheme} />
          {summary.name}
        </span>
      }
      description={
        <span className="flex flex-col gap-0.5">
          {summary.description && <span>{summary.description}</span>}
          <span>{facts}</span>
          {!ready && (
            <span className="flex flex-col gap-0.5">
              <span className="text-foreground">Needs fixes before it can be used:</span>
              <ul aria-label={`What ${summary.name} needs fixed`} className="list-disc pl-4">
                {summary.problems.map((problem) => (
                  <li
                    key={`${problem.check}:${problem.scheme}:${problem.field}:${problem.message}`}
                  >
                    {problemText(problem)}
                  </li>
                ))}
              </ul>
            </span>
          )}
        </span>
      }
    >
      {picked ? (
        <Button size="sm" onClick={() => update({ suit: null })}>
          Turn off
        </Button>
      ) : (
        ready && (
          <Button
            size="sm"
            disabled={suitsOff}
            aria-label={`Use ${summary.name}`}
            onClick={() => update({ suit: summary.id })}
          >
            Use
          </Button>
        )
      )}
    </SettingRow>
  );
}

/** One sentence on what's on screen, when it isn't simply the picked Suit. */
function statusNote(input: {
  pickedName: string | undefined;
  pickedReady: boolean;
  showing: boolean;
  suitsOff: boolean;
  themeName: string;
}): string | undefined {
  if (input.suitsOff) return `Suits are off for this session, so ${input.themeName} shows.`;
  if (input.showing)
    return "The Suit sets colours, fonts and shape. Theme and Accent apply again when it's off.";
  if (input.pickedName && !input.pickedReady)
    return `${input.pickedName} needs fixes, so ${input.themeName} shows.`;
  return undefined;
}

export function SuitsSection() {
  const { summaries, failed } = useSuitLibrary();
  const { appearance, suit, suitsOff } = useTheme();
  const picked = summaries?.find((summary) => summary.id === appearance.suit);
  const note = statusNote({
    pickedName: picked?.name,
    pickedReady: picked ? suitReady(picked) : true,
    showing: suit !== null,
    suitsOff,
    themeName: themes[appearance.theme].name,
  });
  const row = settingRow("appearance.suits");
  return (
    <SettingSection label={row.title} anchor={row.id} scope="device" card note={note}>
      {summaries === undefined ? (
        <SettingRow title="Reading Suits…" />
      ) : summaries.length === 0 ? (
        <SettingRow
          title={failed ? "Suits couldn't be read" : "No Suits yet"}
          description="Ask an agent to make one: describe the look you want."
        />
      ) : (
        summaries.map((summary) => <SuitRow key={summary.id} summary={summary} />)
      )}
    </SettingSection>
  );
}
