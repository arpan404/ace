import XCTest

/// Density, the custom accent and themed screens behind Settings, against the spike fixture
/// (`bun run spike:daemon`; `TEST_RUNNER_ACE_IOS_SPIKE_PORT`, `TEST_RUNNER_ACE_IOS_SHOTS`).
@MainActor final class DensityAccentUITests: XCTestCase, @unchecked Sendable {
    private var port: String { ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841" }
    /// The fixture's first row, at the top of the inbox.
    private let row = "thread.ios-log-failed"
    override func setUp() { continueAfterFailure = false }

    func testCompactTightensTheInboxAndTranscriptButKeepsRowsTouchSized() {
        let app = launch()
        defer { reset(app); app.terminate() }
        setAppearance(app) { app.buttons["Comfortable"].firstMatch.tap() }
        let comfortable = rowHeight(app)
        shot("density-comfortable-inbox")
        openThread(app)
        shot("density-comfortable-thread")
        app.navigationBars.buttons.firstMatch.tap()

        setAppearance(app) {
            app.buttons["Compact"].firstMatch.tap()
            self.shot("density-compact-appearance")
        }
        let compact = rowHeight(app)
        shot("density-compact-inbox")
        XCTAssertLessThan(compact, comfortable, "Compact tightens inbox rows")
        XCTAssertGreaterThanOrEqual(compact, 44, "an inbox row stays a touch target")
        openThread(app)
        shot("density-compact-thread")
        app.navigationBars.buttons.firstMatch.tap()
    }

    func testAPickedColourBecomesTheAccentAndPaperRecoloursTheScreensBehindSettings() {
        let app = launch()
        defer { reset(app); app.terminate() }
        app.openBrowseDestination("settings.appearance")
        XCTAssertTrue(app.buttons["appearance.light"].waitForExistence(timeout: 10))
        app.buttons["appearance.light"].tap()
        app.buttons["appearance.theme.paper"].tap()
        app.buttons["appearance.accent.theme"].tap()

        // The system colour picker: its grid of colours, then close it.
        let custom = app.descendants(matching: .any)["appearance.accent.custom"].firstMatch
        XCTAssertTrue(custom.waitForExistence(timeout: 10))
        XCTAssertTrue(custom.isEnabled, "a connected machine fits the colour")
        custom.tap()
        let grid = app.buttons["Grid"].firstMatch
        XCTAssertTrue(grid.waitForExistence(timeout: 10))
        grid.tap()
        // The grid has no identifier of its own; it fills the middle of the picker's sheet.
        // Two different cells, so the last pick is a change whatever colour was kept before.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.62)).tap()
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.20, dy: 0.66)).tap()
        shot("accent-custom-picker")
        // The picker's X; a zero-sized "Close" also sits in its tree.
        let close = app.buttons.matching(NSPredicate(format: "label == %@", "Close")).allElementsBoundByIndex.first { $0.frame.width > 0 }
        if let close { close.tap() } else { app.swipeDown() }
        // The bridge fits the colour; the custom swatch then holds the selection.
        let selected = expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: custom)
        wait(for: [selected], timeout: 15)
        XCTAssertTrue(app.buttons["appearance.dark"].waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1)
        shot("accent-custom-light-paper")
        app.buttons["appearance.dark"].tap()
        Thread.sleep(forTimeInterval: 1)
        shot("accent-custom-dark-paper")
        app.buttons["appearance.light"].tap()

        // Paper behind Settings: the inbox, then a thread.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.closeSheet()
        XCTAssertTrue(app.buttons[row].waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 1.5)
        shot("paper-light-inbox")
        openThread(app)
        shot("paper-light-thread")
        app.navigationBars.buttons.firstMatch.tap()
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launch()
        return app
    }
    private func setAppearance(_ app: XCUIApplication, _ change: () -> Void) {
        app.openBrowseDestination("settings.appearance")
        let density = app.segmentedControls["appearance.density"].firstMatch
        for _ in 0..<4 where !density.isHittable { app.swipeUp() }
        change()
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.closeSheet()
    }
    private func rowHeight(_ app: XCUIApplication) -> CGFloat {
        let element = app.buttons[row]
        XCTAssertTrue(element.waitForExistence(timeout: 20))
        // Let a closing sheet or page finish moving before measuring and taking shots.
        Thread.sleep(forTimeInterval: 1.5)
        return element.frame.height
    }
    private func openThread(_ app: XCUIApplication) {
        app.buttons[row].tap()
        XCTAssertTrue(app.descendants(matching: .any)["transcript"].firstMatch.waitForExistence(timeout: 20))
        Thread.sleep(forTimeInterval: 1.5)
    }
    /// Back to the defaults, so other tests see the standard look.
    private func reset(_ app: XCUIApplication) {
        app.terminate()
        app.launch()
        app.openBrowseDestination("settings.appearance")
        guard app.buttons["appearance.theme.ace"].waitForExistence(timeout: 10) else { return }
        app.buttons["appearance.theme.ace"].tap()
        app.buttons["appearance.accent.theme"].tap()
        app.buttons["appearance.system"].tap()
        for _ in 0..<4 where !app.buttons["Comfortable"].firstMatch.isHittable { app.swipeUp() }
        app.buttons["Comfortable"].firstMatch.tap()
    }
    private func shot(_ name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? screenshot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
