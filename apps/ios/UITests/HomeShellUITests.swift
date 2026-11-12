import XCTest

/// The home shell: Threads, Chats, Spade and Search in the tab bar,
/// compose on the lists, and Search holding the places a More tab used to. Run against the
/// fixture (`ACE_IOS_SPIKE_PORT`, `TEST_RUNNER_ACE_IOS_SPIKE_PORT` for another port). With
/// `TEST_RUNNER_ACE_SHOT_DIR` set, each step's screenshot is written there too.
@MainActor final class HomeShellUITests: XCTestCase, @unchecked Sendable {
    private let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
    override func setUp() { continueAfterFailure = false }

    func testTheTabBarHoldsThreadsChatsSpadeAndSearch() {
        let app = launch()
        let bar = app.tabBars.firstMatch
        XCTAssertTrue(bar.buttons["Threads"].waitForExistence(timeout: 30))
        XCTAssertTrue(bar.buttons["Chats"].exists)
        XCTAssertTrue(app.buttons["Search"].exists)
        // Spade sits between Chats and Search, as the web's rail places it.
        let spade = bar.buttons["Spade"]
        XCTAssertTrue(spade.exists)
        XCTAssertLessThan(bar.buttons["Chats"].frame.midX, spade.frame.midX)
        XCTAssertLessThan(spade.frame.midX, app.buttons["Search"].frame.midX)
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'coming soon'")).firstMatch.exists)
        // Inbox, Snoozed and Settled under the title; Chats is its own tab, not one of them.
        XCTAssertTrue(app.buttons["threads.tab.inbox"].exists)
        XCTAssertFalse(app.buttons["threads.tab.chats"].exists)
        capture("threads")
        // The scope menu sits beside compose, and starts Select.
        let scope = app.buttons["inbox.projects"]
        XCTAssertTrue(scope.exists)
        XCTAssertLessThan(scope.frame.maxY, app.frame.midY)
        scope.tap()
        let select = app.buttons.matching(NSPredicate(format: "identifier == 'inbox.select' OR label == 'Select threads'")).firstMatch
        XCTAssertTrue(select.waitForExistence(timeout: 5))
        capture("scope-menu")
        select.tap()
        XCTAssertTrue(app.buttons["select.done"].waitForExistence(timeout: 5))
        // Picking hides the tab bar for the selection's own bar.
        XCTAssertFalse(app.tabBars.firstMatch.buttons["Threads"].isHittable)
    }

    func testComposeOnChatsStartsAChatAndOnThreadsAThread() {
        let app = launch()
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 30))
        XCTAssertEqual(app.newThreadButton.label, "New thread")
        app.tabBars.firstMatch.buttons["Chats"].tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat.")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'thread.ios-'")).firstMatch.exists)
        capture("chats")
        let compose = app.newThreadButton
        XCTAssertTrue(compose.waitForExistence(timeout: 5))
        XCTAssertEqual(compose.label, "New chat")
        compose.tap()
        XCTAssertEqual(app.buttons["newThread.project"].waitForExistence(timeout: 10) ? app.buttons["newThread.project"].label : nil, "Project, none")
    }

    func testSearchListsThePlacesAndOpensOne() {
        let app = launch()
        app.openSearch()
        for place in ["pulls", "issues", "automations", "skills", "usage", "machines", "settings"] {
            XCTAssertTrue(app.buttons["search.place.\(place)"].waitForExistence(timeout: 10), "\(place) is missing from Places")
        }
        XCTAssertFalse(app.buttons["search.place.spade"].exists)
        capture("search")
        app.buttons["search.place.settings"].tap()
        XCTAssertTrue(app.buttons["settings.machines"].waitForExistence(timeout: 10))
        // The machine tools moved from More into Settings.
        for _ in 0..<4 where !app.buttons["library.projects"].isHittable { app.swipeUp() }
        XCTAssertTrue(app.buttons["library.projects"].exists)
        capture("settings")
    }

    func testTypingInSearchFindsSettingsPagesAndThreads() {
        let app = launch()
        app.openSearch()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("dark mode")
        let appearance = app.buttons["search.command.settings:appearance"]
        XCTAssertTrue(appearance.waitForExistence(timeout: 10))
        // It says where it goes.
        XCTAssertTrue(appearance.label.contains("Settings"))
        capture("search-typed")
        appearance.tap()
        XCTAssertTrue(app.navigationBars["Appearance"].waitForExistence(timeout: 10))
    }

    func testAThreadOpenedFromSearchShowsOnThreads() {
        let app = launch()
        app.openSearch()
        let latest = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'search.latest.'")).firstMatch
        XCTAssertTrue(latest.waitForExistence(timeout: 15))
        latest.tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        // A thread page hides the tab bar.
        XCTAssertFalse(app.tabBars.firstMatch.buttons["Threads"].isHittable)
    }

    func testTheInboxLinkClosesTheOpenThreadAndShowsThreadsInbox() {
        let app = launch()
        XCTAssertTrue(app.inboxReady.waitForExistence(timeout: 30))
        app.tapThreadsTab(app.buttons["threads.tab.snoozed"])
        app.tabBars.firstMatch.buttons["Chats"].tap()
        let chat = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat.")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        chat.tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 20))
        app.open(URL(string: "ace://inbox")!)
        XCTAssertTrue(app.inboxReady.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["threads.tab.inbox"].isSelected)
        XCTAssertFalse(app.buttons["thread.menu"].exists)
        XCTAssertTrue(app.tabBars.firstMatch.buttons["Threads"].isSelected)
    }

    func testTheIPadSidebarFootCarriesThePlacesInTheWebRailsOrder() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad layout") }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = launch()
        let row = app.buttons["thread.ios-form"]
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        let places = ["sidebar.threads", "sidebar.chats", "sidebar.spade", "sidebar.search", "sidebar.place.pulls", "sidebar.place.automations",
                      "sidebar.place.skills", "sidebar.place.settings"].map { app.buttons[$0] }
        XCTAssertTrue(places[0].waitForExistence(timeout: 10))
        // Left to right in the rail's order, with no tab bar beside the list.
        let xs = places.map(\.frame.midX)
        XCTAssertEqual(xs, xs.sorted())
        XCTAssertFalse(app.tabBars.firstMatch.buttons["Threads"].isHittable)
        capture("ipad-sidebar")
        app.buttons["sidebar.place.settings"].tap()
        XCTAssertTrue(app.buttons["settings.machines"].waitForExistence(timeout: 10))
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        if let appearance = ProcessInfo.processInfo.environment["ACE_SHOT_APPEARANCE"] { app.launchArguments += ["-ace.appearance", appearance] }
        app.launch()
        allowNotifications()
        return app
    }
    /// The first launch asks to send notifications; the fixture's tests take Allow.
    private func allowNotifications() {
        let allow = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 4) { allow.tap() }
    }
    private func capture(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "shell-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_SHOT_DIR"] {
            let scheme = ProcessInfo.processInfo.environment["ACE_SHOT_APPEARANCE"] ?? "dark"
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name)-\(scheme).png"))
        }
    }
}
