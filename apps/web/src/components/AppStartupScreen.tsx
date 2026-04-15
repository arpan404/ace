import { motion } from "motion/react";
import type { AppStartupState } from "../appStartup";
import { APP_VERSION } from "../branding";
import { APP_LOGO_SVG_MARKUP } from "../brandLogo";

type AppStartupScreenProps = {
  readonly state: AppStartupState;
  readonly message: string;
};

export function AppStartupScreen(_props: AppStartupScreenProps) {
  return (
    <div className="relative flex h-screen flex-col items-center justify-center overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent" />

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="relative flex flex-col items-center justify-center"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1], delay: 0.1 }}
          className="relative mb-5 h-20 w-20"
        >
          <div
            className="relative h-full w-full"
            dangerouslySetInnerHTML={{ __html: APP_LOGO_SVG_MARKUP }}
          />
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="relative mb-16"
        >
          <motion.span
            animate={{
              scale: [1, 1.2, 1, 1.1, 1],
              opacity: [0.8, 1, 0.8, 1, 0.8],
            }}
            transition={{
              duration: 10,
              repeat: Infinity,
              ease: "easeInOut",
            }}
            className="text-6xl font-extrabold tracking-tight text-foreground inline-block"
          >
            ace
          </motion.span>
        </motion.div>
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.4 }}
        className="absolute bottom-10 text-xs font-medium tracking-wider text-muted-foreground/40 uppercase"
      >
        Version {APP_VERSION}
      </motion.div>
    </div>
  );
}
