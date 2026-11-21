import XCTest

extension XCUIApplication {
    /// Launches the app and makes sure the copy on screen got `launchArguments`. An iOS 27
    /// simulator starts the app in the background after an install, with no arguments, and the
    /// first `launch()` after that can land on the system's copy: it runs as a release would,
    /// never reaches the fixture, and every list stays empty (#2086). A fixture launch (`--spike`,
    /// `--chat-render-fixture`) reports the arguments it got, as a JSON array, in the hidden
    /// `launch.arguments` element. A copy without them shows no such element. Either mismatch
    /// launches again. Any other launch is a plain `launch()`.
    /// A `--perf-probe` launch gets a fresh `--perf-probe-run`, so `probe` reads this launch's
    /// numbers and never an earlier one's.
    @MainActor func launchWithArguments() {
        guard launchArguments.contains("--spike") || launchArguments.contains("--chat-render-fixture") else {
            launch(); return
        }
        if launchArguments.contains("--perf-probe") {
            if let at = launchArguments.firstIndex(of: "--perf-probe-run") {
                launchArguments.removeSubrange(at..<min(at + 2, launchArguments.count))
            }
            launchArguments += ["--perf-probe-run", UUID().uuidString]
        }
        let probe = descendants(matching: .any)["launch.arguments"]
        var got = "nothing"
        for _ in 0..<3 {
            launch()
            guard probe.waitForExistence(timeout: 10) else { got = "no launch.arguments element"; continue }
            got = probe.value as? String ?? ""
            if (try? JSONDecoder().decode([String].self, from: Data(got.utf8))) == launchArguments { return }
        }
        XCTFail("the app never started with its arguments \(launchArguments); it reported \(got)")
    }
}
