/**
 * The notification database format this build writes. It reads only this one and format 4,
 * which it upgrades in place (see `NotificationDatabase`); older stores are refused.
 */
export const FORMAT = 5;
