import { motion } from "motion/react";
import { useEffect, useState } from "react";
import type { AppStartupState } from "../appStartup";
import { APP_VERSION } from "../branding";
import { APP_LOGO_SVG_MARKUP } from "../brandLogo";
import { LOADING_WORDS } from "./loadingWords";

type AppStartupScreenProps = {
  readonly state: AppStartupState;
  readonly message: string;
};

const Spinner = () => (
  <motion.div
    className="relative h-5 w-5"
    animate={{ rotate: 360 }}
    transition={{ duration: 1, ease: "linear", repeat: Infinity }}
  >
    <div className="absolute inset-0 rounded-full border-[2px] border-transparent border-t-foreground/40" />
    <div className="absolute inset-[3px] rounded-full border-[2px] border-transparent border-t-foreground/20" />
  </motion.div>
);

export function AppStartupScreen({ state, message }: AppStartupScreenProps) {
  const [currentWord, setCurrentWord] = useState(LOADING_WORDS[0] ?? "Starting");
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    setCurrentWord(LOADING_WORDS[0] ?? "Starting");
  }, [state]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setWordIndex((prev) => (prev + 1) % LOADING_WORDS.length);
    }, 1400);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const next = LOADING_WORDS[wordIndex] ?? "Starting";
    setCurrentWord(next);
  }, [wordIndex]);

  return (
    <div className="relative flex h-screen flex-col items-center justify-center overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary)_10%,transparent)_0%,transparent_45%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom,color-mix(in_srgb,var(--foreground)_6%,transparent)_0%,transparent_55%)]" />
        <div className="absolute inset-0 opacity-[0.18] [background-image:linear-gradient(to_right,color-mix(in_oklab,var(--color-foreground)_6%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklab,var(--color-foreground)_6%,transparent)_1px,transparent_1px)] [background-size:56px_56px]" />
      </div>

      <div className="relative flex flex-col items-center">
        <div className="mb-3 h-16 w-16" dangerouslySetInnerHTML={{ __html: APP_LOGO_SVG_MARKUP }} />

        <div className="mb-6 flex items-baseline gap-3">
          <span className="text-4xl font-bold tracking-tight">ACE</span>
          <span className="text-sm font-medium text-muted-foreground/60">{APP_VERSION}</span>
        </div>

        <div className="flex items-center gap-2">
          <motion.div
            key={currentWord}
            initial={{ opacity: 0, y: -6, filter: "blur(2px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.28 }}
            className="text-lg font-medium tracking-tight text-foreground/90"
          >
            {currentWord}
            <span className="text-foreground/60">…</span>
          </motion.div>
          <Spinner />
        </div>

        {message && <div className="mt-4 truncate text-sm text-muted-foreground/80">{message}</div>}
      </div>
    </div>
  );
}
