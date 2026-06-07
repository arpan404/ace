import { LazyMotion, domAnimation, m } from "motion/react";
import type { AppStartupState } from "../appStartup";
import { APP_VERSION } from "../branding";

type AppStartupScreenProps = {
  readonly state: AppStartupState;
  readonly message: string;
};

export function AppStartupScreen({ message }: AppStartupScreenProps) {
  return (
    <LazyMotion features={domAnimation}>
      <div
        role="status"
        aria-live="polite"
        aria-label={message}
        className="relative flex h-screen flex-col items-center justify-center overflow-hidden bg-background text-foreground"
      >
        <m.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="relative flex flex-col items-center text-center"
        >
          <m.span
            animate={{ opacity: [0.7, 1, 0.7] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
            className="inline-block font-mono text-5xl font-semibold tracking-tight text-foreground sm:text-6xl"
          >
            ace
          </m.span>
        </m.div>

        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35, delay: 0.3 }}
          className="absolute bottom-10 font-mono text-[11px] tracking-wide text-muted-foreground/45"
        >
          v{APP_VERSION}
        </m.div>
      </div>
    </LazyMotion>
  );
}
