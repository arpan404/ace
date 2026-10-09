import { ProjectIcon } from "@ace/protocol";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { ProjectImage } from "@/components/project-image.tsx";
import { TextField } from "./form-parts.tsx";

export function projectIconProblem(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (ProjectIcon.safeParse(value).success) return undefined;
  return "Use an http or https image address, or upload a small image.";
}

async function uploadIcon(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|gif|webp|x-icon|vnd.microsoft.icon)$/.test(file.type))
    throw new Error("Choose a PNG, JPEG, GIF, WebP or ICO image.");
  if (file.size > 5 * 1024 * 1024) throw new Error("Choose an image smaller than 5 MB.");
  const image = await createImageBitmap(file);
  try {
    if (!image.width || !image.height) throw new Error("That image couldn't be read.");
    const scale = Math.min(1, 64 / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("That image couldn't be read.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/png");
    if (data.length > 128 * 1024)
      throw new Error("That image is too large. Choose a smaller image.");
    return data;
  } finally {
    image.close();
  }
}

/** Kept in the lazy project dialogs, including image decoding and upload controls. */
export function ProjectIconField(props: {
  name: string;
  value: string | null | undefined;
  onChange(value: string | null): void;
  disabled?: boolean;
  defaultIcon?: string | null | undefined;
  onBusy?(busy: boolean): void;
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const issue = problem ?? projectIconProblem(props.value);
  const upload = (file: File) => {
    setBusy(true);
    props.onBusy?.(true);
    setProblem(undefined);
    return uploadIcon(file)
      .then(props.onChange)
      .catch((error: unknown) => {
        setProblem(error instanceof Error ? error.message : "That image couldn't be read.");
      })
      .finally(() => {
        setBusy(false);
        props.onBusy?.(false);
      });
  };
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-secondary text-sm font-medium text-muted-foreground">
          <ProjectImage
            icon={issue ? undefined : (props.value ?? props.defaultIcon)}
            className="h-8 w-8 rounded-sm object-contain"
            fallback={<span aria-hidden>{props.name.trim().slice(0, 2).toUpperCase() || "P"}</span>}
          />
        </div>
        <div className="grid gap-1">
          <span className="text-sm font-medium">Project icon</span>
          <span className="text-xs text-subtle-foreground">
            Upload an image or paste an image URL. Otherwise, use the project favicon.
          </span>
        </div>
      </div>
      <TextField
        label="Icon URL"
        value={props.value?.startsWith("data:") ? "" : (props.value ?? "")}
        onChange={(value) => {
          setProblem(undefined);
          props.onChange(value.trim() || null);
        }}
        problem={issue}
        showProblem
        disabled={props.disabled || busy}
        placeholder="https://example.com/favicon.ico"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={props.disabled || busy}
          onClick={() => fileInput.current?.click()}
        >
          {busy ? "Reading image…" : "Upload image"}
        </Button>
        <input
          ref={fileInput}
          id={id}
          tabIndex={-1}
          aria-label="Upload project icon"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon"
          className="sr-only"
          disabled={props.disabled || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
        {props.value && (
          <Button
            size="sm"
            variant="ghost"
            disabled={props.disabled || busy}
            onClick={() => {
              setProblem(undefined);
              props.onChange(null);
            }}
          >
            {props.defaultIcon ? "Use project favicon" : "Remove icon"}
          </Button>
        )}
      </div>
    </div>
  );
}
