import XCTest

extension XCUIApplication {
    /// Launches the app and makes sure the copy on screen got `launchArguments`. An iOS 27
    /// simulator starts the app in the background after an install, with no arguments, and the
    /// first `launch()` after that can land on the system's copy: it runs as a release would,
    /// never reaches the fixture, and every list stays empty (#2086). The app reports the
    /// arguments it got in the hidden `launch.arguments` element; on a mismatch this launches again.
    @MainActor func launchWithArguments() {
        let wanted = launchArguments.joined(separator: "\n")
        let probe = descendants(matching: .any)["launch.arguments"]
        var got = "nothing"
        for _ in 0..<3 {
            launch()
            guard probe.waitForExistence(timeout: 10) else { got = "no launch.arguments element"; continue }
            got = probe.value as? String ?? ""
            if got == wanted { return }
        }
        XCTFail("the app never started with its arguments \(launchArguments); it reported \(got)")
    }
}
