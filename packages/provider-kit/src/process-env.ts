/**
 * Bounds for a child process environment ace builds from its own. A person's real environment
 * runs to hundreds of variables (shell setup, version managers, desktop sessions), and an
 * account's environment is that plus its home selectors, so a bound must sit above anything an
 * OS can launch with and only stop runaway input. Linux caps one variable at 128 KiB
 * (MAX_ARG_STRLEN) and the whole block at ARG_MAX; macOS and Windows sit below both.
 */
export const ENV_VARIABLE_LIMIT = 4096;
export const ENV_NAME_LIMIT = 4096;
export const ENV_VALUE_LIMIT = 131_072;
