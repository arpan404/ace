import { isGlassEffectAPIAvailable, isLiquidGlassAvailable } from "expo-glass-effect";
import { Platform } from "react-native";
import { formatErrorMessage } from "../errors";

let hasLoggedAvailabilityError = false;

export function canUseNativeGlass(): boolean {
  if (Platform.OS !== "ios") {
    return false;
  }
  try {
    return isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
  } catch (error) {
    if (!hasLoggedAvailabilityError) {
      hasLoggedAvailabilityError = true;
      console.error(
        `[glass-effect] Failed to evaluate native liquid glass availability: ${formatErrorMessage(error)}`,
      );
    }
    return false;
  }
}
