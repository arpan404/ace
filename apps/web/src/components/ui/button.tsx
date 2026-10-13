import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn.ts";

const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap select-none focus-ring touch-hit",
    "transition-[background-color,color,box-shadow,transform] duration-(--motion-fast) ease-smooth active:not-aria-[haspopup]:scale-[0.98]",
    "disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    /*
     * Four variants, by job (docs/design/visual-language.md):
     * - primary: the one action a surface exists for (Allow once, Run now, Take over, Save).
     * - secondary: any other labelled action, outlined so it reads as a button at rest
     *   (Stop, Cancel beside a primary, filters, Preview beside a field).
     * - ghost: actions inside dense chrome (toolbars, menus' footers, row hovers).
     * - danger: the confirming action of a destructive confirmation (Delete, Remove, Revoke,
     *   Discard), a solid fill in the theme's failed hue (theme/danger.ts). Cancel sits before it.
     * `tone="danger"` colours a ghost or secondary that opens such a confirmation, or a
     * destructive row action; never the confirming button itself.
     */
    variants: {
      variant: {
        primary:
          "bg-tint text-tint-foreground hover:bg-[color-mix(in_oklab,var(--ring),var(--background)_14%)]",
        secondary:
          "bg-transparent text-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-accent aria-expanded:bg-accent",
        ghost:
          "bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
        danger: "bg-danger text-danger-foreground hover:bg-danger-hover active:bg-danger-pressed",
      },
      tone: {
        default: "",
        danger: "text-destructive hover:bg-destructive/10 hover:text-destructive",
      },
      size: {
        sm: "h-[26px] rounded-sm px-2.5 text-sm touch-hit-lg",
        default: "h-[30px] rounded-md px-3 text-ui",
        lg: "h-9 rounded-card px-4 text-base",
      },
    },
    defaultVariants: { variant: "secondary", tone: "default", size: "default" },
  },
);

function Button({
  className,
  variant,
  tone,
  size,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant ?? "secondary"}
      className={cn(buttonVariants({ variant, tone, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
