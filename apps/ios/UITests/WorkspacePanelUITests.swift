import XCTest

/// The thread's side panel on iPad against the spike fixture: tools open as tabs beside the
/// thread, tabs close, reopen, pin and are remembered per thread across a relaunch; in portrait
/// the list steps aside for the panel; a narrow window keeps the phone's sheets. Run on a fresh
/// fixture, `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selecting its port; `ACE_IOS_SHOTS` (a folder) also
/// saves each screenshot there.
@MainActor final class WorkspacePanelUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    override func tearDown() { XCUIDevice.shared.orientation = .portrait }

    func testToolsOpenAsTabsBesideTheThreadAndTabsCloseReopenAndPin() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad layout") }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = launch()
        open("thread.ios-plan", in: app)
        XCTAssertTrue(title("Plan the kill-all filters", in: app).waitForExistence(timeout: 20))
        // Beside the list there is no tab bar: the sidebar carries Threads and Pull requests.
        XCTAssertTrue(app.tabBars.buttons["Pulls"].waitForNotHittable(timeout: 5), "a launch in landscape keeps the tab bar hidden")
        // A fresh thread's panel opens on Changes beside Files, the list still beside the thread.
        let toggle = app.buttons["thread.panel"]
        XCTAssertTrue(toggle.waitForHittable(timeout: 10))
        toggle.tap()
        let changes = app.buttons["panel.tab.changes"], files = app.buttons["panel.tab.files"]
        XCTAssertTrue(changes.waitForHittable(timeout: 10))
        XCTAssertTrue(files.reachable)
        XCTAssertTrue(changes.isSelected)
        XCTAssertTrue(app.buttons["sidebar.threads"].reachable, "landscape has room for the list, the thread and the panel")
        XCTAssertFalse(app.buttons["changes.close"].exists, "the tab strip closes it, not a sheet's own button")
        screenshot("ipad-panel-changes")

        // The thread's ⋯ menu opens a tool as a tab, not a sheet over the thread.
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.terminal").tap()
        let terminal = app.buttons["panel.tab.terminal"]
        XCTAssertTrue(terminal.waitForHittable(timeout: 10))
        XCTAssertTrue(terminal.isSelected)
        screenshot("ipad-panel-terminal")

        // + opens another; its close button closes it, and Reopen closed tab brings it back.
        app.buttons["panel.open"].tap()
        menuItem("Agents", in: app).tap()
        let agents = app.buttons["panel.tab.agents"]
        XCTAssertTrue(agents.waitForHittable(timeout: 10))
        screenshot("ipad-panel-agents")
        app.buttons["panel.tab.terminal.close"].tap()
        XCTAssertTrue(terminal.waitForNonExistence(timeout: 10))
        app.buttons["panel.menu"].tap()
        menuItem("Reopen closed tab", in: app).tap()
        XCTAssertTrue(terminal.waitForHittable(timeout: 10))
        XCTAssertLessThan(terminal.frame.minX, agents.frame.minX, "it comes back where it stood")

        // Pinned tabs lose their close button and sit first.
        terminal.tap()
        app.buttons["panel.menu"].tap()
        menuItem("Pin tab", in: app).tap()
        XCTAssertTrue(app.buttons["panel.tab.terminal.close"].waitForNonExistence(timeout: 10))
        // Close other tabs leaves the pinned ones.
        app.buttons["panel.menu"].tap()
        menuItem("Close other tabs", in: app).tap()
        XCTAssertTrue(agents.waitForNonExistence(timeout: 10))
        XCTAssertTrue(changes.reachable && files.reachable && terminal.reachable)
        XCTAssertFalse(app.tabBars.buttons["Pulls"].reachable, "opening and closing the panel keeps the tab bar hidden")
        screenshot("ipad-panel-pinned")

        // Each thread keeps its own panel: another thread starts with none showing.
        open("thread.ios-question", in: app)
        XCTAssertTrue(title("Clean up the release notes", in: app).waitForExistence(timeout: 20))
        XCTAssertTrue(changes.waitForNonExistence(timeout: 10))
        // A relaunch brings the first thread's panel back as it was.
        app.terminate()
        let again = launch()
        open("thread.ios-plan", in: again)
        XCTAssertTrue(title("Plan the kill-all filters", in: again).waitForExistence(timeout: 20))
        XCTAssertTrue(again.buttons["panel.tab.terminal"].waitForHittable(timeout: 10))
        XCTAssertFalse(again.buttons["panel.tab.agents"].exists)
    }

    func testTheBrowserOpensInThePanelBesideTheThread() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad layout") }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = launch()
        open("thread.ios-browser", in: app)
        XCTAssertTrue(title("Check the checkout flow", in: app).waitForExistence(timeout: 20))
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.browser").tap()
        XCTAssertTrue(app.buttons["panel.tab.browser"].waitForHittable(timeout: 15))
        XCTAssertTrue(app.buttons["browser.menu"].waitForExistence(timeout: 15))
        XCTAssertTrue(title("Check the checkout flow", in: app).exists, "the thread stays beside the browser")
        XCTAssertTrue(app.textViews["composer.input"].exists)
        screenshot("ipad-panel-browser")
    }

    func testInPortraitTheListStepsAsideForThePanelAndComesBackAfter() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad layout") }
        XCUIDevice.shared.orientation = .portrait
        let app = launch()
        open("thread.ios-approval", in: app)
        XCTAssertTrue(title("Fix the flaky queue test", in: app).waitForExistence(timeout: 20))
        let threads = app.buttons["sidebar.threads"]
        XCTAssertTrue(threads.reachable)
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.changes").tap()
        XCTAssertTrue(app.buttons["panel.tab.changes"].waitForHittable(timeout: 10))
        XCTAssertTrue(threads.waitForNotHittable(timeout: 10), "the list and the panel don't both fit in portrait")
        screenshot("ipad-portrait-panel")
        app.buttons["thread.panel"].tap()
        XCTAssertTrue(app.buttons["panel.tab.changes"].waitForNonExistence(timeout: 10))
        XCTAssertTrue(threads.waitForHittable(timeout: 10), "the list comes back once the panel goes")
        // Turned to landscape with the panel showing, all three sit side by side.
        app.buttons["thread.panel"].tap()
        XCTAssertTrue(app.buttons["panel.tab.changes"].waitForHittable(timeout: 10))
        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(threads.waitForHittable(timeout: 10))
        XCTAssertTrue(app.buttons["panel.tab.changes"].reachable)
        screenshot("ipad-landscape-panel-after-turn")
    }

    func testThePanelsEdgeDragsToResizeAndTheWidthIsKept() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad layout") }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = launch()
        open("thread.ios-form", in: app)
        XCTAssertTrue(title("Deploy the preview", in: app).waitForExistence(timeout: 20))
        app.buttons["thread.panel"].tap()
        let panel = app.otherElements["panel"]
        XCTAssertTrue(panel.waitForExistence(timeout: 10))
        sleep(1)
        let before = panel.frame
        let screen = app.coordinate(withNormalizedOffset: .zero)
        let edge = screen.withOffset(CGVector(dx: before.minX - 2, dy: before.midY))
        edge.press(forDuration: 0.3, thenDragTo: screen.withOffset(CGVector(dx: before.minX - 120, dy: before.midY)), withVelocity: .slow, thenHoldForDuration: 0.3)
        sleep(1)
        let wider = panel.frame.width
        XCTAssertGreaterThan(wider, before.width + 60, "the edge drags the panel wider")
        screenshot("ipad-panel-resized")
        // The width is the thread's: it comes back after a relaunch.
        sleep(1)
        app.terminate()
        let again = launch()
        open("thread.ios-form", in: again)
        let kept = again.otherElements["panel"]
        XCTAssertTrue(kept.waitForExistence(timeout: 20))
        sleep(1)
        XCTAssertEqual(kept.frame.width, wider, accuracy: 4)
    }

    func testTheKeyboardOpensClosesAndReopensPanelTabs() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad layout") }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = launch()
        open("thread.ios-form", in: app)
        XCTAssertTrue(title("Deploy the preview", in: app).waitForExistence(timeout: 20))
        // The simulator drops the first key it sends while it attaches its keyboard.
        app.typeKey(XCUIKeyboardKey.shift, modifierFlags: [])
        app.typeKey("`", modifierFlags: .control)
        let terminal = app.buttons["panel.tab.terminal"]
        XCTAssertTrue(terminal.waitForHittable(timeout: 10))
        app.typeKey("w", modifierFlags: [.command, .option])
        XCTAssertTrue(terminal.waitForNonExistence(timeout: 10))
        app.typeKey("t", modifierFlags: [.command, .option, .shift])
        XCTAssertTrue(terminal.waitForHittable(timeout: 10))
        // ⇧⌘B hides and shows the panel.
        app.typeKey("b", modifierFlags: [.command, .shift])
        XCTAssertTrue(terminal.waitForNonExistence(timeout: 10))
        app.typeKey("b", modifierFlags: [.command, .shift])
        XCTAssertTrue(terminal.waitForHittable(timeout: 10))
    }

    func testANarrowWindowKeepsThePhonesSheets() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad windows") }
        let app = launch()
        let full = app.windows.firstMatch.frame
        open("thread.ios-approval", in: app)
        XCTAssertTrue(title("Fix the flaky queue test", in: app).waitForExistence(timeout: 20))
        resize(app, toWidth: 420, height: full.height - 60)
        guard app.windows.firstMatch.frame.width < full.width - 100 else { throw XCTSkip("the window did not resize: windowed apps are off") }
        XCTAssertFalse(app.buttons["thread.panel"].exists, "no room for a panel: no panel button")
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.changes").tap()
        let close = app.buttons["changes.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 10), "Changes opens as the phone's sheet")
        screenshot("ipad-narrow-changes-sheet")
        close.tap()
        resize(app, toWidth: full.width, height: full.height)
        XCTAssertTrue(app.buttons["thread.panel"].waitForHittable(timeout: 10))
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        let screen = XCUIApplication(bundleIdentifier: "com.apple.springboard").frame
        if UIDevice.current.userInterfaceIdiom == .pad, app.windows.firstMatch.frame.width < screen.width - 1 {
            resize(app, toWidth: screen.width, height: screen.height)
        }
        return app
    }
    /// Moves the window to the screen's top-leading corner and drags its resize grip so it is
    /// `width` by `height` points (iPadOS 26 windowed apps).
    private func resize(_ app: XCUIApplication, toWidth width: CGFloat, height: CGFloat) {
        let screen = XCUIApplication(bundleIdentifier: "com.apple.springboard").coordinate(withNormalizedOffset: .zero)
        var frame = app.windows.firstMatch.frame
        if frame.minX > 0 || frame.minY > 0 {
            let top = CGVector(dx: frame.midX + 40, dy: frame.minY + 8)
            screen.withOffset(top).press(forDuration: 1, thenDragTo: screen.withOffset(CGVector(dx: top.dx - frame.minX, dy: 8)), withVelocity: .slow, thenHoldForDuration: 0.5)
            sleep(2)
            frame = app.windows.firstMatch.frame
        }
        let grip = screen.withOffset(CGVector(dx: frame.maxX - 2, dy: frame.maxY - 2))
        grip.press(forDuration: 1, thenDragTo: screen.withOffset(CGVector(dx: frame.minX + width, dy: frame.minY + height)), withVelocity: .slow, thenHoldForDuration: 0.5)
        sleep(3)
    }
    /// A row of an open menu, by its words (menus don't carry their rows' identifiers).
    private func menuItem(_ label: String, in app: XCUIApplication) -> XCUIElement {
        let item = app.collectionViews.buttons[label].firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 10))
        return item
    }
    private func open(_ id: String, in app: XCUIApplication) {
        let row = app.buttons[id]
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
    }
    private func title(_ text: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "thread.title").matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}

private extension XCUIElement {
    var reachable: Bool { exists && isHittable }
    func waitForHittable(timeout: TimeInterval) -> Bool { settles(timeout) { $0.reachable } }
    func waitForNotHittable(timeout: TimeInterval) -> Bool { settles(timeout) { !$0.reachable } }
    private func settles(_ timeout: TimeInterval, _ condition: (XCUIElement) -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if condition(self) { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return condition(self)
    }
}
