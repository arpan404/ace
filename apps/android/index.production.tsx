import { registerRootComponent } from "expo";
import { useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { PairingScreen } from "./src/Pairing.tsx";
import { ThemeContext } from "./src/theme.tsx";

/**
 * Fail-closed production entry. Release builds show the pairing flow but
 * have no pairing wiring yet (parity task A02.08 production startup with the
 * ticket-authenticated identity read), so the screen runs its entry,
 * confirmation and built-in camera capture but pairing stays disabled with
 * guidance: the code can be checked against the computer's screen, and
 * nothing here imports the fixture runtime, the replay probe, or input
 * metrics, and the React Native default fetch or WebSocket never carries
 * pairing material.
 */
function ProductionPairing() {
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  return (
    <ThemeContext.Provider value={scheme}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <PairingScreen onPaired={() => {}} />
        </KeyboardProvider>
      </SafeAreaProvider>
    </ThemeContext.Provider>
  );
}

registerRootComponent(ProductionPairing);
