import { registerRootComponent } from "expo";
import { Text, View } from "react-native";

/**
 * Fail-closed production entry. Release builds have no pairing flow yet (M02 owns
 * it), so production renders an unpaired shell and never imports the fixture
 * runtime, replay probe, or input metrics. Keep this dependency graph minimal.
 */
function ProductionUnavailable() {
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
      <Text>
        This build is not paired with a daemon yet. Pairing arrives with production startup.
      </Text>
    </View>
  );
}

registerRootComponent(ProductionUnavailable);
