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
  <div className="flex items-center gap-1">
    {[0, 1, 2].map((i) => (
      <motion.div
        key={i}
        className="h-2 w-2 rounded-full bg-foreground/80"
        animate={{ opacity: [0.3, 1, 0.3], scale: [0.7, 1.2, 0.7] }}
        transition={{
          duration: 1,
          repeat: Infinity,
          delay: i * 0.15,
          ease: "easeInOut",
        }}
      />
    ))}
  </div>
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

        <div className="mb-6 relative">
          <div className="flex items-baseline">
            <span className="text-4xl font-bold tracking-tight">ace</span>
            <span className="ml-0.5 align-super text-[10px] font-medium text-muted-foreground/60">{APP_VERSION}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <motion.div
            key={currentWord}
            initial={{ opacity: 0, y: -6, filter: "blur(2px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.28 }}
            className="text-lg font-medium tracking-tight text-foreground/90"
          >
            {currentWord}
          </motion.div>
          <Spinner />
        </div>
      </div>
    </div>
  );
}
