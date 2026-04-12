import { motion, type Variants } from "motion/react";
import { useEffect, useState } from "react";
import type { AppStartupState } from "../appStartup";
import { LOADING_WORDS } from "./loadingWords";

type AppStartupScreenProps = {
  readonly state: AppStartupState;
  readonly message: string;
};

const PulsingDots = () => {
  const containerVariants: Variants = {
    animate: {
      transition: {
        staggerChildren: 0.12,
      },
    },
  };

  const dotVariants: Variants = {
    initial: {
      y: "0%",
    },
    animate: {
      y: ["0%", "-100%", "0%"],
      transition: {
        duration: 0.9,
        ease: "easeInOut",
        repeat: Infinity,
        repeatDelay: 0.55,
      },
    },
  };

  return (
    <motion.div
      className="flex h-7 items-center justify-center gap-2"
      variants={containerVariants}
      initial="initial"
      animate="animate"
    >
      <motion.div
        className="h-2.5 w-2.5 rounded-full bg-foreground/90 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-foreground)_18%,transparent)]"
        variants={dotVariants}
      />
      <motion.div
        className="h-2.5 w-2.5 rounded-full bg-foreground/90 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-foreground)_18%,transparent)]"
        variants={dotVariants}
      />
      <motion.div
        className="h-2.5 w-2.5 rounded-full bg-foreground/90 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-foreground)_18%,transparent)]"
        variants={dotVariants}
      />
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
    // Rotate at a human pace (no flicker), and avoid random repeats.
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
    <div className="relative flex h-screen flex-col items-center justify-center overflow-hidden bg-background text-foreground">
      {/* Ambient backdrop */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--primary)_10%,transparent)_0%,transparent_45%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom,color-mix(in_srgb,var(--foreground)_6%,transparent)_0%,transparent_55%)]" />
        <div className="absolute inset-0 opacity-[0.18] [background-image:linear-gradient(to_right,color-mix(in_oklab,var(--color-foreground)_6%,transparent)_1px,transparent_1px),linear-gradient(to_bottom,color-mix(in_oklab,var(--color-foreground)_6%,transparent)_1px,transparent_1px)] [background-size:56px_56px]" />
      </div>

      <div className="relative mx-auto w-full max-w-md px-6">
        <div className="rounded-2xl border border-border/20 bg-card/30 p-6 shadow-[0_10px_40px_-18px_rgba(0,0,0,0.6)] backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <div className="relative grid size-10 place-items-center rounded-xl border border-border/25 bg-background/40">
              <div className="absolute inset-0 rounded-xl bg-[radial-gradient(circle_at_30%_20%,color-mix(in_srgb,var(--primary)_18%,transparent)_0%,transparent_60%)]" />
              <div className="relative h-4.5 w-4.5 rounded-sm bg-foreground/90 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-foreground)_22%,transparent)]" />
            </div>
            <div className="min-w-0">
              <div className="text-[11px] font-semibold tracking-[0.22em] text-muted-foreground/70 uppercase">
                Starting up
              </div>
              <motion.div
                key={currentWord}
                initial={{ opacity: 0, y: -6, filter: "blur(2px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{ duration: 0.28 }}
                className="truncate text-lg font-medium tracking-tight text-foreground/90"
              >
                {currentWord}
                <span className="text-foreground/60">…</span>
              </motion.div>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-muted-foreground/80">{message}</div>
            </div>
            <PulsingDots />
          </div>

          {/* Indeterminate progress */}
          <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-foreground/8">
            <div className="h-full w-[42%] animate-[startup-sheen_1.6s_ease-in-out_infinite] rounded-full bg-linear-to-r from-transparent via-primary/55 to-transparent" />
          </div>
        </div>
      </div>

      <style>
        {`
          @keyframes startup-sheen {
            0% { transform: translateX(-80%); opacity: 0.0; }
            18% { opacity: 0.9; }
            50% { opacity: 0.7; }
            100% { transform: translateX(260%); opacity: 0.0; }
          }
        `}
      </style>
    </div>
  );
}
