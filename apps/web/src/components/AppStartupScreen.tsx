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
    className="relative h-4 w-4"
    animate={{ rotate: 360 }}
    transition={{ duration: 1, ease: "linear", repeat: Infinity }}
  >
    <div className="absolute inset-0 rounded-full border border-foreground/30" />
    <div className="absolute inset-0 rounded-full border-l-2 border-t-foreground/60" />
  </motion.div>
);

export function AppStartupScreen({ state, message }: AppStartupScreenProps) {
  const [currentWord, setCurrentWord] = useState(state === "connecting" ? "Connecting" : "Loading");
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    setCurrentWord(state === "connecting" ? "Connecting" : "Loading");
  }, [state]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setWordIndex((prev) => (prev + 1) % LOADING_WORDS.length);
    }, 1500);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const next = LOADING_WORDS[wordIndex] ?? "Loading";
    setCurrentWord(next);
  }, [wordIndex]);

  return (
    <div className="flex h-screen flex-col items-center justify-center overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--primary)_8%,transparent_65%)]" />
      </div>

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="relative flex flex-col items-center"
      >
        <div
          className="mb-6 h-20 w-20 text-foreground"
          dangerouslySetInnerHTML={{ __html: APP_LOGO_SVG_MARKUP }}
        />

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
          className="mb-8 flex items-baseline gap-3"
        >
          <span className="text-4xl font-bold tracking-tight">ACE</span>
          <span className="text-sm font-medium text-muted-foreground/60">{APP_VERSION}</span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.4 }}
          className="flex items-center gap-2"
        >
          <motion.div
            key={currentWord}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="min-w-24 text-center text-sm font-medium text-muted-foreground/80"
          >
            {currentWord}
          </motion.div>
          <Spinner />
        </motion.div>

        {message && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, delay: 0.6 }}
            className="mt-6 max-w-xs text-center text-xs text-muted-foreground/50"
          >
            {message}
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}
