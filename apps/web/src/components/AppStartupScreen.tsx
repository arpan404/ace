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
        staggerChildren: 0.1,
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
        duration: 0.8,
        ease: "easeInOut",
        repeat: Infinity,
        repeatDelay: 0.4,
      },
    },
  };

  return (
    <motion.div
      className="flex justify-center items-center gap-2 h-8"
      variants={containerVariants}
      initial="initial"
      animate="animate"
    >
      <motion.div className="w-3 h-3 bg-foreground rounded-full" variants={dotVariants} />
      <motion.div className="w-3 h-3 bg-foreground rounded-full" variants={dotVariants} />
      <motion.div className="w-3 h-3 bg-foreground rounded-full" variants={dotVariants} />
    </motion.div>
  );
};

export function AppStartupScreen({ state, message }: AppStartupScreenProps) {
  const [currentWord, setCurrentWord] = useState(state === "connecting" ? "Connecting" : "Loading");

  useEffect(() => {
    setCurrentWord(state === "connecting" ? "Connecting" : "Loading");
  }, [state]);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentWord(LOADING_WORDS[Math.floor(Math.random() * LOADING_WORDS.length)] ?? "Loading");
    }, 300);

    return () => {
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="relative flex h-screen flex-col items-center justify-center overflow-hidden bg-background text-foreground">
      <div className="flex flex-col items-center gap-4">
        <PulsingDots />
        <motion.p
          key={currentWord}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="text-lg font-medium text-foreground"
        >
          {currentWord}...
        </motion.p>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
