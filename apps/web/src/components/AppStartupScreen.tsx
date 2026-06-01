import { LazyMotion, domAnimation, m } from "motion/react";
import type { AppStartupState } from "../appStartup";
import { APP_VERSION } from "../branding";

type AppStartupScreenProps = {
  readonly state: AppStartupState;
  readonly message: string;
};

export function AppStartupScreen(_props: AppStartupScreenProps) {
  return (
    <LazyMotion features={domAnimation}>
      <div className="relative flex h-screen flex-col items-center justify-center overflow-hidden bg-background text-foreground">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent" />
        <m.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="relative flex flex-col items-center justify-center"
        >
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.2 }}
            className="relative mb-16"
          >
            <m.span
              animate={{
                scale: [1, 1.2, 1, 1.1, 1],
                opacity: [0.8, 1, 0.8, 1, 0.8],
              }}
              transition={{
                duration: 10,
                repeat: Infinity,
                ease: "easeInOut",
              }}
              className="inline-block text-6xl font-extrabold tracking-tight text-foreground"
            >
              ace
            </m.span>
          </m.div>
        </m.div>

        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="absolute bottom-10 text-xs font-medium uppercase tracking-wider text-muted-foreground/40"
        >
          Version {APP_VERSION}
        </m.div>
      </div>
    </LazyMotion>
  );
}
