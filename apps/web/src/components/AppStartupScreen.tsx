import { motion, type Variants } from "motion/react";
import { useEffect, useState } from "react";
import type { AppStartupState } from "../appStartup";
import { APP_VERSION } from "../branding";
import { LOADING_WORDS } from "./loadingWords";

type AppStartupScreenProps = {
  readonly state: AppStartupState;
  readonly message: string;
};

const Spinner = () => {
  return (
    <motion.div
      className="relative h-5 w-5"
      animate={{ rotate: 360 }}
      transition={{ duration: 1, ease: "linear", repeat: Infinity }}
    >
      <div className="absolute inset-0 rounded-full border-[2px] border-transparent border-t-foreground/40" />
      <div className="absolute inset-[3px] rounded-full border-[2px] border-transparent border-t-foreground/20" />
    </motion.div>
  );
};

export function AppStartupScreen({ state, message }: AppStartupScreenProps) {
  const [currentWord, setCurrentWord] = useState(state === "connecting" ? "Connecting" : "Loading");
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    setCurrentWord(state === "connecting" ? "Connecting" : "Loading");
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
    const next = LOADING_WORDS[wordIndex] ?? "Loading";
    setCurrentWord(next);
  }, [wordIndex]);

  return (
    <div className="flex h-screen flex-col items-center justify-center overflow-hidden bg-background text-foreground">
      <div className="flex flex-col items-center gap-2">
        <div className="flex items-baseline gap-3">
          <span className="text-3xl font-semibold tracking-tight text-foreground">ACE</span>
          <span className="text-sm font-medium text-muted-foreground/60">{APP_VERSION}</span>
        </div>

        <div className="flex items-center gap-2 pt-1">
          <motion.div
            key={currentWord}
            initial={{ opacity: 0, y: -4, filter: "blur(2px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.25 }}
            className="text-sm text-muted-foreground/70"
          >
            {currentWord}
          </motion.div>
          <Spinner />
        </div>

        {message && <div className="mt-3 text-xs text-muted-foreground/50">{message}</div>}
      </div>
    </div>
  );
}
