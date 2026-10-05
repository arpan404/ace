import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn.ts";

const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center gap-1.5 font-medium whitespace-nowrap select-none focus-ring touch-hit",
    "transition-[background-color,color,box-shadow,transform] duration-(--dur-1) ease-smooth active:not-aria-[haspopup]:scale-[0.98]",
    "disabled:pointer-events-none disabled:opacity-50 data-disabled:pointer-events-none data-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        /** The quiet default: a 7% ink fill. */
        secondary:
          "bg-secondary text-foreground hover:bg-[color-mix(in_oklab,var(--secondary),var(--foreground)_7%)] aria-expanded:bg-[color-mix(in_oklab,var(--secondary),var(--foreground)_7%)]",
        /** Ink button for the one primary action on a surface. */
        primary:
          "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklab,var(--primary),var(--background)_14%)]",
        ghost:
          "bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
        outline:
          "bg-transparent text-foreground shadow-[inset_0_0_0_1px_var(--border)] hover:bg-accent aria-expanded:bg-accent",
        danger:
          "bg-secondary text-destructive hover:bg-[color-mix(in_oklab,var(--secondary),var(--destructive)_12%)]",
        link: "h-auto bg-transparent px-0 text-foreground underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-[26px] rounded-sm px-2.5 text-[12px] touch-hit-lg",
        default: "h-[30px] rounded-md px-3 text-ui",
        lg: "h-9 rounded-card px-4 text-base",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Button, buttonVariants };
