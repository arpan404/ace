import XCTest

/// A thread's pages on a phone: Chat and Changes are two buttons in the bar beside ⋯, shown only
/// when the thread has changes; Files, Terminal, Browser and Agents push from ⋯. Run on a fresh
/// fixture; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port, `TEST_RUNNER_ACE_IOS_APPEARANCE`
/// light or dark (dark by default) and `TEST_RUNNER_ACE_IOS_SHOTS` a folder for the screenshots.
@MainActor final class ThreadPagesUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testChatAndChangesSwitchFromTheBarBesideTheMenu() {
        let app = launch(into: "thread.ios-changes")
        let menu = app.buttons["thread.menu"]
        let chat = app.buttons["thread.page.chat"]
        let changes = app.buttons["thread.page.changes"]
        XCTAssertTrue(chat.waitForExistence(timeout: 25), "a thread with changes shows Chat in the bar")
        XCTAssertTrue(changes.exists)
        XCTAssertTrue(changes.label.hasPrefix("Changes, "), "Changes reads its file count: \(changes.label)")
        XCTAssertTrue(chat.isSelected, "the thread opens on Chat")
        XCTAssertFalse(changes.isSelected)
        // Both sit on the bar's row, before ⋯, and the title never runs into them.
        XCTAssertEqual(chat.frame.midY, menu.frame.midY, accuracy: 4)
        XCTAssertLessThan(changes.frame.maxX, menu.frame.minX + 1)
        XCTAssertLessThan(app.threadTitle().frame.maxX, chat.frame.minX + 1, "the title stops before the page buttons")
        XCTAssertFalse(app.descendants(matching: .any)["thread.pages"].exists, "no pill row under the title")
        shot("changes-chat")

        changes.tap()
        XCTAssertTrue(app.descendants(matching: .any)["thread.page.changes.body"].waitForExistence(timeout: 10), "Changes shows its page")
        XCTAssertTrue(changes.isSelected)
        XCTAssertFalse(chat.isSelected)
        shot("changes-changes")
        chat.tap()
        XCTAssertTrue(app.scrollViews["transcript"].isHittable, "Chat comes back")

        // Files is in ⋯ now, and pushes over the thread; back returns to it.
        menu.tap()
        let files = app.buttons["thread.files"]
        XCTAssertTrue(files.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["thread.agents"].exists && app.buttons["thread.browser"].exists && app.buttons["thread.terminal"].exists)
        shot("changes-menu")
        files.tap()
        XCTAssertTrue(app.navigationBars["Files"].waitForExistence(timeout: 10), "Files is pushed")
        XCTAssertFalse(chat.exists, "a pushed screen has its own bar")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
    }

    func testAThreadWithoutChangesShowsNoPageButtonsAndPushesItsScreens() {
        let app = launch(into: "thread.ios-done")
        let menu = app.buttons["thread.menu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 25))
        XCTAssertFalse(app.buttons["thread.page.chat"].exists, "nothing to switch to: no page buttons")
        XCTAssertFalse(app.buttons["thread.page.changes"].exists)
        shot("done-chat")
        menu.tap()
        let agents = app.buttons["thread.agents"]
        XCTAssertTrue(agents.waitForExistence(timeout: 10))
        shot("done-menu")
        agents.tap()
        XCTAssertTrue(app.descendants(matching: .any)["agents.page"].waitForExistence(timeout: 10), "Agents is pushed")
        XCTAssertTrue(app.navigationBars["Agents"].exists)
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(menu.waitForExistence(timeout: 10), "back returns to the thread")
    }

    private var appearance: String { ProcessInfo.processInfo.environment["ACE_IOS_APPEARANCE"] ?? "dark" }

    private func launch(into row: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841",
                               "-ace.appearance", appearance]
        app.launch()
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        if alert.waitForExistence(timeout: 3) {
            alert.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Don'")).firstMatch.tap()
        }
        app.revealRow(row).tap()
        return app
    }

    private func shot(_ name: String) {
        let screen = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screen)
        attachment.name = "pages-\(name)-\(appearance)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? screen.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name)-\(appearance).png"))
        }
    }
}
