/**
 * Settings › Beta's switches for features still being tried out, each one global daemon setting
 * (`beta.*`) that defaults off. The words are shared by every client's Beta page.
 */
export const betaSwitches = {
  spade: {
    title: "Spade",
    description: "ace's assistant, with its own place in the rail.",
  },
  marketplace: {
    title: "Marketplace",
    description: "Suits, skills, plugins and bots made by others, to browse and install.",
  },
} as const;
