import type { DeviceFailure } from "@ace/protocol";

/**
 * Why a devices channel answers no, in the words every client shows. A refused request is
 * always answered with one of these, on the direct socket and over the relay alike, so a
 * client can say why instead of waiting on a list that never comes.
 */
export const deviceAccessRefused: DeviceFailure = {
  code: "permission_denied",
  message: "Administrator scope is required for device access",
  hint: "Connect with an administrator device credential to use Devices.",
};

export const devicesUnavailable: DeviceFailure = {
  code: "not_supported",
  message: "Devices service is unavailable on this daemon",
  hint: "Check the daemon's device service and reconnect.",
};
