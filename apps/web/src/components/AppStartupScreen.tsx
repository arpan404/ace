import { APP_LOGO_SVG_MARKUP } from "~/brandLogo";

export function AppStartupScreen({ message }: { message: string }) {
  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-64 bg-[radial-gradient(52rem_20rem_at_top,color-mix(in_srgb,var(--primary)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_99%,transparent)_0%,color-mix(in_srgb,var(--background)_92%,var(--primary)_3%)_48%,color-mix(in_srgb,var(--background)_98%,transparent)_100%)]" />
        <div className="absolute inset-x-0 bottom-0 h-48 bg-[linear-gradient(180deg,transparent,color-mix(in_srgb,var(--background)_94%,transparent))]" />
      </div>

      <div className="relative flex flex-1 items-center justify-center px-6 py-10">
        <section className="relative flex w-full max-w-md flex-col items-center text-center">
          <div className="relative mb-8 flex size-44 items-center justify-center">
            <svg
              viewBox="0 0 160 160"
              fill="none"
              aria-hidden="true"
              className="app-startup-orbit absolute inset-0 size-full text-primary/24"
            >
              <circle
                cx="80"
                cy="80"
                r="58"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeDasharray="10 12"
              />
              <circle
                cx="80"
                cy="80"
                r="72"
                stroke="currentColor"
                strokeWidth="0.8"
                strokeDasharray="4 8"
                opacity="0.56"
              />
              <circle cx="80" cy="24" r="4.5" fill="currentColor" className="app-startup-beacon" />
            </svg>

            <div className="app-startup-logo-shell relative flex size-28 items-center justify-center overflow-hidden rounded-[2rem] border border-border/60 bg-card/78 shadow-[0_28px_80px_-28px_color-mix(in_srgb,var(--foreground)_28%,transparent)] backdrop-blur-xl">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_28%_24%,color-mix(in_srgb,var(--primary)_18%,transparent),transparent_58%)]" />
              <div className="absolute inset-x-6 bottom-0 h-px bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--foreground)_18%,transparent),transparent)]" />
              <div
                className="app-startup-logo relative size-16 text-foreground dark:text-white/95"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: APP_LOGO_SVG_MARKUP }}
              />
            </div>

            <span className="app-startup-spark absolute left-6 top-9 size-2 rounded-full bg-foreground/18" />
            <span className="app-startup-spark-delayed absolute bottom-7 right-8 size-3 rounded-full bg-primary/72 shadow-[0_0_24px_color-mix(in_srgb,var(--primary)_55%,transparent)]" />
          </div>

          <p className="text-[10px] font-semibold uppercase tracking-[0.34em] text-muted-foreground/58">
            Launching ace
          </p>
          <h1 className="mt-3 text-balance text-[clamp(1.6rem,2vw+1rem,2.25rem)] font-semibold tracking-tight text-foreground/96">
            Workbench warming up
          </h1>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground/72">
            {message}
          </p>

          <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-border/55 bg-card/55 px-3 py-1.5 text-[11px] text-muted-foreground/70 shadow-sm backdrop-blur-md">
            <span className="size-1.5 rounded-full bg-primary/85 animate-pulse" />
            <span>Preparing workspace context</span>
          </div>
        </section>
      </div>
    </div>
  );
}
