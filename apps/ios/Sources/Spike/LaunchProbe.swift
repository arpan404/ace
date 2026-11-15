import SwiftUI

/// Fixture builds only: the arguments this process was launched with, as one hidden accessibility
/// value, so a UI test can tell its own launch from a copy the system started without them. An
/// iOS 27 simulator starts the app in the background after an install (`UIBackgroundModes`
/// fetch), and a test's first launch can land on that copy, which runs as a release would and
/// never reaches the fixture (#2086). Release builds compile it away.
struct LaunchProbeView: View {
    /// The arguments after the executable's path, one per line.
    nonisolated static let value: String = ProcessInfo.processInfo.arguments.dropFirst().joined(separator: "\n")

    var body: some View {
        #if ACE_FIXTURE
        Color.clear.frame(width: 1, height: 1)
            .accessibilityElement()
            .accessibilityIdentifier("launch.arguments")
            .accessibilityValue(Self.value)
            .allowsHitTesting(false)
        #endif
    }
}
