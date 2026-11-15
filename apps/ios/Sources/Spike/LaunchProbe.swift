import SwiftUI

/// Fixture launches only (`--spike`, `--chat-render-fixture`): the arguments this process was
/// launched with, as a JSON array in one accessibility value, so a UI test can tell its own launch
/// from a copy the system started without them. An iOS 27 simulator starts the app in the
/// background after an install (`UIBackgroundModes` fetch), and a test's first launch can land on
/// that copy, which runs as a release would and never reaches the fixture (#2086). An ordinary
/// Debug launch draws nothing here, so VoiceOver never finds it; release builds compile it away.
struct LaunchProbeView: View {
    var body: some View {
        #if ACE_FIXTURE
        if SpikeConfiguration.enabled || SpikeConfiguration.renderFixtureEnabled {
            // XCUI can't see an element hidden from accessibility, so this one stays visible to
            // it: static text that never changes, read after everything else on the screen.
            Color.clear.frame(width: 1, height: 1)
                .accessibilityElement()
                .accessibilityAddTraits(.isStaticText)
                .accessibilityIdentifier("launch.arguments")
                .accessibilityValue(Self.value)
                .accessibilitySortPriority(-1_000)
                .allowsHitTesting(false)
        }
        #endif
    }

    /// The arguments after the executable's path, as a JSON array of strings.
    private static let value: String = {
        let arguments = Array(ProcessInfo.processInfo.arguments.dropFirst())
        return (try? JSONEncoder().encode(arguments)).map { String(decoding: $0, as: UTF8.self) } ?? "[]"
    }()
}
