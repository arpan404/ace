import { initials } from "@ace/ui-core";
import {
  spadeAvatarColors,
  spadeAvatarFill,
  type SpadeAvatar,
  type SpadeAvatarColor,
} from "@ace/ui-core/spade-chat";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { SpadeFace } from "./spade-face.tsx";

/** The face as the person is choosing it: a colour, a new picture, or the one it has. */
export type AvatarDraft =
  | { kind: "generated"; color: SpadeAvatarColor }
  | { kind: "image"; data: string }
  | { kind: "current"; avatar: SpadeAvatar };

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const maxImageBytes = 3_750_000;

/**
 * A bot's face: its initials on one of the palette's colours, or an uploaded picture (PNG, JPEG,
 * GIF or WebP up to 3.75 MB, Spade's own limits). The face on the left shows the choice.
 */
export function AvatarChoice(props: {
  name: string;
  value: AvatarDraft;
  onChange(value: AvatarDraft): void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();
  const { value } = props;
  const picked = value.kind === "generated" ? value.color : undefined;
  const upload = (chosen: File | undefined) => {
    if (!chosen) return;
    if (!imageTypes.has(chosen.type)) return setProblem("Use a PNG, JPEG, GIF or WebP picture.");
    if (chosen.size > maxImageBytes) return setProblem("Use a picture smaller than 3.75 MB.");
    setProblem(undefined);
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") props.onChange({ kind: "image", data: reader.result });
    });
    reader.readAsDataURL(chosen);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        {value.kind === "image" ? (
          <img alt="" src={value.data} className="size-10 rounded-full object-cover" />
        ) : (
          <SpadeFace
            size={40}
            avatar={
              value.kind === "current"
                ? value.avatar
                : { kind: "generated", initials: initials(props.name) || "?", color: value.color }
            }
          />
        )}
        <div role="radiogroup" aria-label="Colour" className="flex flex-wrap items-center gap-1.5">
          {spadeAvatarColors.map((color) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={picked === color}
              aria-label={color}
              onClick={() => props.onChange({ kind: "generated", color })}
              className={cn(
                "size-6 rounded-full focus-ring",
                picked === color && "shadow-[0_0_0_2px_var(--popover),0_0_0_4px_var(--foreground)]",
              )}
              style={{ backgroundColor: spadeAvatarFill[color] }}
            />
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => file.current?.click()}>
          Upload picture
        </Button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          aria-label="Picture"
          className="hidden"
          onChange={(event) => {
            upload(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      {problem && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
