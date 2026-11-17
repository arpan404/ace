import XCTest

/// The home shell: Threads, Chats, Spade (the fixture's machine shows it), Code review and Search in the tab bar,
/// compose on the lists, and Search holding the places a More tab used to. Run against the
/// fixture (`ACE_IOS_SPIKE_PORT`, `TEST_RUNNER_ACE_IOS_SPIKE_PORT` for another port). With
/// `TEST_RUNNER_ACE_SHOT_DIR` set, each step's screenshot is written there too.
@MainActor final class HomeShellUITests: XCTestCase, @unchecked Sendable {
    private let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
    override func setUp() { continueAfterFailure = false }

    func testTheTabBarHoldsProjectsChatsSpadeAndSearch() {
        let app = launch()
        let bar = app.tabBars.firstMatch
        XCTAssertTrue(bar.buttons["Projects"].waitForExistence(timeout: 30))
        XCTAssertTrue(bar.buttons["Chats"].exists)
        XCTAssertTrue(app.buttons["Search"].exists)
        // The fixture's machine shows Spade: its tab follows Chats.
        let spade = bar.buttons["Spade"]
        XCTAssertTrue(spade.waitForExistence(timeout: 15))
        XCTAssertGreaterThan(spade.frame.minX, bar.buttons["Chats"].frame.minX)
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
        XCTAssertFalse(app.tabBars.firstMatch.buttons["Projects"].isHittable)
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
        // The pill reads "Project" with the choice as its value (aa84168b9).
        let project = app.buttons["newThread.project"]
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        XCTAssertEqual(project.value as? String, "No project", "a chat starts with no project")
    }

    func testSearchListsThePlacesAndOpensOne() {
        let app = launch()
        app.openSearch()
        for place in ["pulls", "issues", "automations", "skills", "usage", "history", "archived", "machines", "settings"] {
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

    func testSearchShowsItsFieldAtOnceAndASecondTapFocusesIt() {
        let app = launch()
        app.openSearch()
        // No pull-down: the field is there as the tab opens.
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertTrue(field.isHittable, "Search's field is hidden until the list is pulled down")
        capture("search-field")
        // Where Search is a plain tab (iOS 27, compose detached), the first tap shows Search and
        // tapping it again focuses the field. On iOS 26 the system's own search tab turns into
        // the field, which takes the tap.
        let tab = app.tabBars.firstMatch.buttons["Search"]
        if tab.exists && tab.isHittable {
            XCTAssertFalse(app.keyboards.firstMatch.exists, "the first tap shows Search without raising the keyboard")
            tab.tap()
        } else {
            field.tap()
        }
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5), "a second tap on Search focuses its field")
    }

    func testUsageAutomationsHistoryAndArchivedEachOpenFromHome() {
        let app = launch()
        // Open Search once: closing a place returns to it, and tapping Search again while it
        // shows focuses its field (#2215) instead of opening it.
        app.openSearch()
        for (place, title) in [("usage", "Usage"), ("automations", "Automations"), ("history", "History"), ("archived", "Archived")] {
            let capsule = app.buttons["search.place.\(place)"]
            XCTAssertTrue(capsule.waitForExistence(timeout: 10), "\(place) is missing from Places")
            capsule.tap()
            XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10), "\(title) didn't open from home")
            capture("place-\(place)")
            app.buttons["settings.close"].tap()
            XCTAssertTrue(app.buttons["search.place.settings"].waitForExistence(timeout: 10))
        }
        // Settings keeps its own way to History and Archived.
        app.buttons["search.place.settings"].tap()
        for _ in 0..<4 where !app.buttons["settings.history"].isHittable { app.swipeUp() }
        XCTAssertTrue(app.buttons["settings.history"].exists)
        XCTAssertTrue(app.buttons["settings.archive"].exists)
    }

    func testThePaletteFiltersCommandsAndRunsTheOneChosen() {
        let app = launch()
        app.openSearch()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("history")
        let history = app.buttons["search.command.history"]
        XCTAssertTrue(history.waitForExistence(timeout: 10))
        // Typing narrows the list: a command that doesn't match is gone.
        XCTAssertFalse(app.buttons["search.command.settings:appearance"].exists)
        capture("palette-history")
        history.tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 10))
        app.buttons["settings.close"].tap()
        // A settings page by name opens on that page. Search keeps its query; clear it first.
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        let clear = field.buttons["Clear text"]
        if clear.exists { clear.tap() }
        field.typeText("keyboard")
        let keyboard = app.buttons["search.command.settings:keyboard"]
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10))
        keyboard.tap()
        XCTAssertTrue(app.navigationBars["Keyboard"].waitForExistence(timeout: 10))
    }

    func testSettingsSearchFindsPhoneAndMachineSettingsAndOpensThemInView() {
        let app = launch()
        app.openSearch()
        app.buttons["search.place.settings"].tap()
        let field = app.searchFields["Search settings"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("dark mode")
        let mode = app.buttons["settings.search.phone/appearance.mode"]
        XCTAssertTrue(mode.waitForExistence(timeout: 10))
        // It says where it sits.
        XCTAssertTrue(mode.label.contains("Appearance"))
        capture("settings-search-phone")
        mode.tap()
        XCTAssertTrue(app.navigationBars["Appearance"].waitForExistence(timeout: 10))
        app.navigationBars.buttons.element(boundBy: 0).tap()
        // A machine's own setting, under that machine's name, opens its page with the row in view.
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        let clear = field.buttons["Clear text"]
        if clear.exists { clear.tap() }
        field.typeText("tailscale")
        let tailscale = app.buttons.matching(NSPredicate(format: "identifier ENDSWITH %@", "/remote/remote.tailscale")).firstMatch
        XCTAssertTrue(tailscale.waitForExistence(timeout: 15))
        XCTAssertTrue(tailscale.label.contains("Remote access"))
        capture("settings-search-machine")
        tailscale.tap()
        XCTAssertTrue(app.navigationBars["Remote access"].waitForExistence(timeout: 10))
        let row = app.switches.matching(NSPredicate(format: "label CONTAINS %@", "Tailscale")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(row.isHittable)
    }

    func testHistorySearchSaysWhenNothingSettledMatches() {
        let app = launch()
        app.openSearch()
        app.buttons["search.place.history"].tap()
        XCTAssertTrue(app.navigationBars["History"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["history.project"].exists)
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("zzqx nothing like it")
        XCTAssertTrue(app.staticTexts["Nothing settled matches “zzqx nothing like it”"].waitForExistence(timeout: 15))
        capture("history-no-match")
    }

    func testChatsFilterNarrowsTheListAndClearingBringsItBack() {
        let app = launch()
        app.tabBars.firstMatch.buttons["Chats"].tap()
        let chat = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat.")).firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 10))
        let identifier = chat.identifier
        // The filter field waits under the title until the list is pulled down.
        let field = app.searchFields["Filter chats"]
        if !field.exists { app.swipeDown() }
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("zzqx")
        XCTAssertTrue(app.staticTexts["No results for “zzqx”"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons[identifier].exists)
        capture("chats-filtered")
        field.buttons["Clear text"].tap()
        XCTAssertTrue(app.buttons[identifier].waitForExistence(timeout: 10))
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
        XCTAssertFalse(app.tabBars.firstMatch.buttons["Projects"].isHittable)
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
        XCTAssertTrue(app.tabBars.firstMatch.buttons["Projects"].isSelected)
    }

    func testTheIPadSidebarFootCarriesThePlacesInTheWebRailsOrder() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad layout") }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = launch()
        let row = app.buttons["thread.ios-form"]
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        let places = ["sidebar.threads", "sidebar.chats", "sidebar.spade", "sidebar.search", "sidebar.review", "sidebar.place.automations",
                      "sidebar.place.skills", "sidebar.place.settings"].map { app.buttons[$0] }
        XCTAssertTrue(places[0].waitForExistence(timeout: 10))
        // Left to right in the rail's order, Spade after Chats while the machine shows it, and
        // no tab bar beside the list.
        let xs = places.map(\.frame.midX)
        XCTAssertEqual(xs, xs.sorted())
        XCTAssertFalse(app.tabBars.firstMatch.buttons["Projects"].isHittable)
        capture("ipad-sidebar")
        // Code review is a place of its own: pull requests and issues, the list beside them kept.
        app.buttons["sidebar.review"].tap()
        XCTAssertTrue(app.buttons["forge.kind.issues"].waitForExistence(timeout: 10))
        capture("ipad-code-review")
        app.buttons["sidebar.place.settings"].tap()
        XCTAssertTrue(app.buttons["settings.machines"].waitForExistence(timeout: 10))
    }

    func testASecondTapOnSearchInTheIPadSidebarFocusesItsField() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad layout") }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = launch()
        let row = app.buttons["thread.ios-form"]
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        let search = app.buttons["sidebar.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        XCTAssertFalse(field.focused, "the first tap shows Search without focusing its field")
        // Search's own page carries the sidebar's places too; Search again asks for the field.
        XCTAssertTrue(search.waitForHittable(timeout: 10))
        search.tap()
        XCTAssertTrue(field.waitFor({ $0.focused }, timeout: 5), "a second tap on Search focuses its field")
        capture("ipad-search-focused")
    }

    func testCodeReviewIsAHomeTabForPullRequestsAndIssues() {
        let app = launch()
        let review = app.tabBars.firstMatch.buttons["Code review"]
        XCTAssertTrue(review.waitForExistence(timeout: 30))
        review.tap()
        XCTAssertTrue(review.isSelected)
        let issues = app.buttons["forge.kind.issues"]
        XCTAssertTrue(issues.waitForExistence(timeout: 20))
        capture("code-review-pulls")
        issues.tap()
        XCTAssertTrue(issues.isSelected)
        capture("code-review-issues")
        app.tabBars.firstMatch.buttons["Projects"].tap()
        XCTAssertTrue(app.buttons["threads.tab.inbox"].waitForExistence(timeout: 10))
    }

    func testCodeReviewWithNoComputerPairedOffersPairing() {
        let app = XCUIApplication()
        // A fresh install: no computer paired, no fixture connected.
        app.launchArguments = ["--spike", "--spike-unpaired"]
        app.launchWithArguments()
        defer { app.terminate() }
        let review = app.tabBars.firstMatch.buttons["Code review"]
        XCTAssertTrue(review.waitForExistence(timeout: 30))
        review.tap()
        // Never skeletons forever: the way to pair a computer.
        XCTAssertTrue(app.buttons["inbox.empty.pair"].waitForExistence(timeout: 20))
        capture("code-review-unpaired")
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        if let appearance = ProcessInfo.processInfo.environment["ACE_SHOT_APPEARANCE"] { app.launchArguments += ["-ace.appearance", appearance] }
        app.launchWithArguments()
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

private extension XCUIElement {
    /// Holds the keyboard's focus. An iPad with a hardware keyboard shows no on-screen one.
    var focused: Bool { (value(forKey: "hasKeyboardFocus") as? Bool) ?? false }
    var reachable: Bool { exists && isHittable }
    func waitForHittable(timeout: TimeInterval) -> Bool { waitFor({ $0.reachable }, timeout: timeout) }
    func waitFor(_ condition: (XCUIElement) -> Bool, timeout: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if condition(self) { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return condition(self)
    }
}
