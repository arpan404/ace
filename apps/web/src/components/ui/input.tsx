import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@/lib/cn.ts";

const field =
  "w-full min-w-0 rounded-md bg-(--field) px-2.5 text-ui text-foreground shadow-[inset_0_0_0_1px_var(--border),var(--depth-well)] outline-none transition-shadow duration-(--motion-fast) placeholder:text-subtle-foreground focus-visible:shadow-[0_0_0_1px_color-mix(in_oklab,var(--ring)_50%,transparent)] disabled:opacity-50 aria-invalid:shadow-[inset_0_0_0_1px_var(--destructive)] pointer-coarse:text-[16px] [field-sizing:content]";

/**
 * A Spade dialog's API-key field: its inset ring sits inside the dialog's field, and the
 * browser's contact and saved-credential buttons have no place on a one-time key.
 */
const apiKeyField =
  "focus-visible:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--ring)_55%,transparent),var(--depth-well)] [&::-webkit-credentials-auto-fill-button]:hidden [&::-webkit-contacts-auto-fill-button]:hidden";

/** Types whose width may follow their words; the rest keep their own. */
const sizedTypes = new Set([undefined, "text", "email", "search", "url", "tel"]);

function Input({ className, ...props }: InputPrimitive.Props) {
  // A field with no width of its own is at least as wide as the words it asks for, so a hint
  // such as "e.g. Messages" is read whole; `size` keeps that true where `field-sizing` isn't.
  const size =
    props.size ??
    (sizedTypes.has(props.type) && props.placeholder
      ? Math.min(String(props.placeholder).length, 80)
      : undefined);
  return (
    <InputPrimitive
      data-slot="input"
      data-part="input"
      data-state={props.disabled ? "disabled" : undefined}
      size={size}
      className={cn(field, "h-8", className)}
      {...props}
    />
  );
}

/**
 * Multi-line field that grows with its text up to 40% of the window, with no resize grip.
 * The composer owns its own textarea.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      data-part="input"
      data-variant="multiline"
      data-state={props.disabled ? "disabled" : undefined}
      className={cn(
        field,
        "max-h-[40vh] min-h-20 resize-none py-2 leading-normal [field-sizing:content]",
        className,
      )}
      {...props}
    />
  );
}

export { Input, Textarea, field as fieldClassName, apiKeyField as apiKeyFieldClassName };
