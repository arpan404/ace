/**
 * A touch screen whose shorter side is under this many CSS pixels is a phone: it gets a phone's
 * user agent. A tablet keeps the browser's own, as tablet browsers send a desktop one.
 */
export const phoneShortSide = 600;

export function phoneSized(width: number, height: number): boolean {
  return Math.min(width, height) < phoneShortSide;
}

/**
 * The user agent and client hints of a phone running this browser's engine, from the engine's
 * own version string (`HeadlessChrome/153.0…`, `Chrome/140.0…`, a full user agent). In Chrome's
 * reduced form: the major version, the rest zeros. Undefined when no Chrome version is in it.
 */
export function mobileAgent(engine: string) {
  const major = /(?:Headless)?Chrome\/(\d+)/.exec(engine)?.[1];
  if (!major) return undefined;
  return {
    userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    userAgentMetadata: {
      brands: [
        { brand: "Chromium", version: major },
        { brand: "Not.A/Brand", version: "99" },
      ],
      fullVersion: `${major}.0.0.0`,
      platform: "Android",
      platformVersion: "10.0.0",
      architecture: "",
      model: "K",
      mobile: true,
    },
  };
}
