import { BadgeColor } from "@ace/protocol";
import { projectBadge } from "@ace/ui-core";
import { projectImageTypes } from "@ace/project-picker";
import { UploadSimpleIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { BadgeColourGroup } from "@/components/ui/account-badge-field.tsx";
import { Button } from "@/components/ui/button.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { accountColors } from "@/components/ui/provider-account-icon.tsx";
import { ProjectMarkView } from "@/components/project-mark.tsx";
import { projectGlyphs } from "@/components/project-glyphs.ts";
import { Icon } from "@/components/icon.tsx";
import type { Project } from "@/lib/projects.ts";
import { lookOf, type IconChoice, type IconMode } from "./icon-choice.ts";
import { readProjectImage } from "./project-image-file.ts";

const modes: readonly { value: IconMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "initials", label: "Initials" },
  { value: "glyph", label: "Icon" },
  { value: "image", label: "Image" },
];

const colours = ["auto", ...BadgeColor.options] as const;
type Colour = (typeof colours)[number];

/**
 * The project's icon: the found favicon (Auto), its initials or a curated glyph in a curated
 * colour, or an image of the person's own. The preview is the sidebar's own badge.
 */
export function ProjectIconChooser(props: {
  project: Project;
  name: string;
  choice: IconChoice;
  onChange(choice: IconChoice): void;
  disabled?: boolean | undefined;
}) {
  const { choice, onChange } = props;
  const file = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();
  const badge = projectBadge({ id: props.project.id, name: props.name });
  const look = lookOf(choice, props.project);
  const swatchLook = (colour: Colour) => ({
    badge: {
      ...(colour === "auto" ? {} : { color: colour }),
      ...(choice.mode === "glyph" ? { glyph: choice.glyph } : {}),
    },
  });

  const pick = async (picked: File | undefined) => {
    if (!picked) return;
    const read = await readProjectImage(picked);
    if (!read.ok) return setProblem(read.problem);
    setProblem(undefined);
    onChange({ ...choice, mode: "image", image: read.icon });
  };

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        <div role="img" aria-label="Icon preview" data-preview="large">
          <ProjectMarkView badge={badge} look={look} size="large" />
        </div>
        <div className="grid min-w-0 flex-1 gap-2">
          <SegmentedControl
            label="Icon"
            size="sm"
            value={choice.mode}
            options={modes}
            onValueChange={(mode) => {
              setProblem(undefined);
              onChange({ ...choice, mode });
            }}
          />
          <div
            data-preview="row"
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
          >
            <ProjectMarkView badge={badge} look={look} />
            <span className="truncate">{props.name || props.project.name}</span>
          </div>
        </div>
      </div>
      {(choice.mode === "initials" || choice.mode === "glyph") && (
        <BadgeColourGroup
          label="Icon colour"
          options={colours}
          value={choice.color ?? "auto"}
          onChange={(colour) =>
            onChange({ ...choice, color: colour === "auto" ? undefined : colour })
          }
          name={(colour) => (colour === "auto" ? "Project colour" : `${capital(colour)}`)}
          ring={(colour) =>
            colour === "auto" ? `var(--project-${badge.tint})` : accountColors[colour]
          }
          renderSwatch={(colour) => <ProjectMarkView badge={badge} look={swatchLook(colour)} />}
        />
      )}
      {choice.mode === "glyph" && (
        <div role="group" aria-label="Icons" className="grid grid-cols-9 gap-1">
          {projectGlyphs.map((entry) => (
            <Tip key={entry.glyph} label={entry.label}>
              <Button
                size="sm"
                variant={choice.glyph === entry.glyph ? "secondary" : "ghost"}
                className="size-8 px-0"
                aria-label={entry.label}
                aria-pressed={choice.glyph === entry.glyph}
                onClick={() => onChange({ ...choice, glyph: entry.glyph })}
              >
                <entry.icon aria-hidden size={16} />
              </Button>
            </Tip>
          ))}
        </div>
      )}
      {choice.mode === "image" && (
        <div className="grid gap-1.5">
          <div>
            <Button
              size="sm"
              variant="secondary"
              disabled={props.disabled}
              onClick={() => file.current?.click()}
            >
              <Icon icon={UploadSimpleIcon} />
              {choice.image ? "Replace image…" : "Choose image…"}
            </Button>
            <input
              ref={file}
              type="file"
              hidden
              aria-label="Project image"
              accept={projectImageTypes.join(",")}
              onChange={(event) => {
                const picked = event.target.files?.[0];
                event.target.value = "";
                void pick(picked);
              }}
            />
          </div>
          {problem && (
            <p role="alert" className="text-xs text-destructive">
              {problem}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const capital = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
