import XCTest

/// The Threads tab's split layout against the spike fixture: on iPad the list stays beside the
/// thread it opens; on a large iPhone, turning it between portrait (compact) and landscape
/// (regular) turns the list into a drawer over the thread and back live, as an iPad window resize or the iPhone Duo
/// folding does, keeping the open thread and its draft. Run on a fresh fixture,
/// `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selecting its port; `ACE_IOS_SHOTS` (a folder) also saves
/// each screenshot there.
@MainActor final class SplitLayoutUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    override func tearDown() { XCUIDevice.shared.orientation = .portrait }

    func testTheThreadListStaysBesideTheThreadsItOpensOnIPad() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad layout") }
        let app = launch()
        open("thread.ios-form", in: app)
        XCTAssertTrue(title("Deploy the preview", in: app).waitForExistence(timeout: 20))
        // The list is still there, the open row selected, and the next thread opens from it.
        let next = app.buttons["thread.ios-question"]
        XCTAssertTrue(next.reachable)
        XCTAssertTrue(app.buttons["thread.ios-form"].isSelected)
        screenshot("ipad-sidebar-thread")
        next.tap()
        XCTAssertTrue(title("Clean up the release notes", in: app).waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["thread.ios-form"].reachable)
        XCTAssertTrue(next.isSelected)
        XCTAssertFalse(app.buttons["thread.ios-form"].isSelected)
    }

    func testTheIPadSidebarCarriesThreadsPullRequestsAndNewThread() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad layout") }
        let app = launch()
        open("thread.ios-form", in: app)
        XCTAssertTrue(title("Deploy the preview", in: app).waitForExistence(timeout: 20))
        // No tab bar beside the list: its places sit at the sidebar's foot, New thread in its bar.
        XCTAssertFalse(app.tabBars.buttons["Pulls"].reachable)
        let threads = app.buttons["sidebar.threads"], pulls = app.buttons["sidebar.pulls"]
        XCTAssertTrue(threads.reachable)
        XCTAssertTrue(threads.isSelected)
        // Pull requests show their own list and page, and Threads comes back to its open thread.
        pulls.tap()
        XCTAssertTrue(app.staticTexts["No pull request open"].waitForExistence(timeout: 10))
        XCTAssertTrue(pulls.isSelected)
        XCTAssertFalse(title("Deploy the preview", in: app).exists)
        screenshot("ipad-sidebar-pulls")
        threads.tap()
        XCTAssertTrue(title("Deploy the preview", in: app).waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["thread.ios-form"].isSelected)
        let compose = app.buttons["inbox.compose"]
        XCTAssertTrue(compose.reachable)
        compose.tap()
        let close = app.buttons["newThread.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 10))
    }

    func testAHardwareKeyboardMovesBetweenThreadsAndOpensAndClosesSheets() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad layout") }
        let app = launch()
        open("thread.ios-form", in: app)
        XCTAssertTrue(title("Deploy the preview", in: app).waitForExistence(timeout: 20))
        // The simulator drops the first key it sends while it attaches its keyboard.
        app.typeKey(XCUIKeyboardKey.shift, modifierFlags: [])
        // ⌘] and ⌘[ walk the list in its own order, even while a field has the keyboard.
        app.typeKey("]", modifierFlags: .command)
        XCTAssertTrue(title("Plan the kill-all filters", in: app).waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["thread.ios-plan"].isSelected)
        app.typeKey("[", modifierFlags: .command)
        XCTAssertTrue(title("Deploy the preview", in: app).waitForExistence(timeout: 20))
        // ⌘N opens New thread, its message field taking the keyboard. The cancel shortcut
        // closes a sheet from there too; it is Esc on a keyboard, and ⌘. here because the
        // simulator does not deliver a bare Esc to the app.
        app.typeKey("n", modifierFlags: .command)
        let close = app.buttons["newThread.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        app.typeKey(".", modifierFlags: .command)
        XCTAssertTrue(close.waitForNonExistence(timeout: 10))
        app.buttons["inbox.settings"].tap()
        let settings = app.buttons["settings.close"]
        XCTAssertTrue(settings.waitForExistence(timeout: 10))
        app.typeKey(".", modifierFlags: .command)
        XCTAssertTrue(settings.waitForNonExistence(timeout: 10))
        // ⌘F searches the list.
        app.typeKey("f", modifierFlags: .command)
        XCTAssertTrue(app.searchFields.firstMatch.waitForExistence(timeout: 10))
    }

    func testNarrowingAnIPadWindowBringsTheTabBarBackAndKeepsTheThreadAndItsDraft() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad windows") }
        let app = launch()
        let full = app.windows.firstMatch.frame
        open("thread.ios-approval", in: app)
        XCTAssertTrue(title("Fix the flaky queue test", in: app).waitForExistence(timeout: 20))
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        input.typeText("Keep this draft")
        // The keyboard covers the window's resize grip: put it away with its own key; the draft stays.
        let hide = app.keyboards.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'keyboard'")).firstMatch
        if hide.exists { hide.tap() }
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        // A compact window: the phone's layout, the tab bar back, the thread and draft kept.
        resize(app, toWidth: 420, height: full.height - 60)
        guard app.windows.firstMatch.frame.width < full.width - 100 else { throw XCTSkip("the window did not resize: windowed apps are off") }
        XCTAssertTrue(title("Fix the flaky queue test", in: app).waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["sidebar.threads"].reachable)
        XCTAssertFalse(app.tabBars.buttons["Threads"].reachable, "as on a phone, the tab bar steps aside for a thread")
        XCTAssertEqual(input.value as? String, "Keep this draft")
        screenshot("ipad-narrow-window-thread")
        // The list comes out over the thread as a drawer, carrying the places the tab bar would.
        app.buttons["thread.sidebar"].tap()
        XCTAssertTrue(app.buttons["thread.ios-approval"].waitForHittable(timeout: 10))
        XCTAssertTrue(app.buttons["sidebar.threads"].reachable)
        screenshot("ipad-narrow-window")
        app.buttons["drawer.close"].tap()
        XCTAssertTrue(title("Fix the flaky queue test", in: app).waitForExistence(timeout: 10))
        XCTAssertEqual(input.value as? String, "Keep this draft")
        // Wide again: the sidebar and its places are back, the tab bar gone, nothing lost.
        resize(app, toWidth: full.width, height: full.height)
        XCTAssertTrue(app.buttons["sidebar.threads"].waitForHittable(timeout: 10))
        XCTAssertFalse(app.tabBars.buttons["Threads"].reachable)
        XCTAssertTrue(app.buttons["thread.ios-approval"].isSelected)
        XCTAssertEqual(input.value as? String, "Keep this draft")
    }

    func testTurningALargePhoneKeepsTheOpenThreadAndItsDraftAsTheListJoinsIt() throws {
        XCUIDevice.shared.orientation = .portrait
        let app = launch()
        // Only the largest phones are regular in landscape.
        guard UIDevice.current.userInterfaceIdiom == .phone, app.windows.firstMatch.frame.width >= 428 else {
            throw XCTSkip("needs an iPhone that is regular width in landscape")
        }
        open("thread.ios-approval", in: app)
        XCTAssertTrue(title("Fix the flaky queue test", in: app).waitForExistence(timeout: 20))
        // The first row, clear of the keyboard in landscape.
        let list = app.buttons["thread.ios-form"]
        XCTAssertFalse(list.reachable, "a compact window gives the thread the whole window")
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        input.typeText("Keep this draft")

        XCUIDevice.shared.orientation = .landscapeLeft
        XCTAssertTrue(list.waitForHittable(timeout: 10), "a regular window shows the list beside the thread")
        XCTAssertTrue(title("Fix the flaky queue test", in: app).exists)
        XCTAssertTrue(app.buttons["thread.ios-approval"].isSelected)
        XCTAssertEqual(input.value as? String, "Keep this draft")
        screenshot("phone-landscape-split")

        // Beside the list the tab bar's places are the sidebar's; Pull requests stays chosen as
        // the window turns compact, where the tab bar is back.
        XCTAssertFalse(app.tabBars.buttons["Pulls"].reachable)
        app.buttons["sidebar.pulls"].tap()
        XCTAssertTrue(app.buttons["sidebar.pulls"].isSelected)
        XCUIDevice.shared.orientation = .portrait
        let pullsTab = app.tabBars.buttons["Pulls"]
        XCTAssertTrue(pullsTab.waitForHittable(timeout: 10), "a compact window has the tab bar back")
        XCTAssertTrue(pullsTab.isSelected)
        XCTAssertFalse(app.buttons["sidebar.pulls"].reachable)
        app.tabBars.buttons["Threads"].tap()
        XCTAssertTrue(list.waitForNotHittable(timeout: 10), "back to compact, the thread stays on top")
        XCTAssertTrue(title("Fix the flaky queue test", in: app).waitForExistence(timeout: 10))
        XCTAssertEqual(input.value as? String, "Keep this draft")
        // The thread's sidebar button brings the list out over it, as on any phone.
        app.buttons["thread.sidebar"].tap()
        XCTAssertTrue(list.waitForHittable(timeout: 10))
    }

    func testBackFromAPageOverTheThreadKeepsTheThreadOpen() throws {
        let app = launch()
        open("thread.ios-browser", in: app)
        XCTAssertTrue(title("Check the checkout flow", in: app).waitForExistence(timeout: 20))
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.browser").tap()
        XCTAssertTrue(app.buttons["browser.menu"].waitForExistence(timeout: 15))
        // A window with room for the side panel opens the browser there instead (`WorkspacePanelUITests`).
        if app.buttons["panel.tab.browser"].exists { throw XCTSkip("the browser opens in the side panel here") }
        // iOS 26 names the Back button; iOS 18 labels it with the thread's title.
        app.navigationBars.buttons.matching(NSPredicate(format: "identifier == 'BackButton' OR label BEGINSWITH 'Check the checkout flow'")).firstMatch.tap()
        XCTAssertTrue(app.buttons["browser.menu"].waitForNonExistence(timeout: 10))
        XCTAssertTrue(title("Check the checkout flow", in: app).waitForExistence(timeout: 10), "the thread stays open under the page")
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        // iPadOS keeps a window's size across launches: start each test from a full one.
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
    /// On screen and reachable; a list under the thread in a collapsed stack is neither.
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
