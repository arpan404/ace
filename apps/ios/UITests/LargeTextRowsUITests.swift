import XCTest

/// Grouped rows at the largest accessibility text size, against the spike fixture
/// (`bun run spike:daemon`): a row stacks, so its value goes under the title and never squeezes
/// a word apart ("Machin es"). `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a
/// folder) also saves screenshots.
@MainActor final class LargeTextRowsUITests: XCTestCase, @unchecked Sendable {
    private let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
    override func setUp() { continueAfterFailure = false }

    func testSettingsRowsStackTheirValueUnderAWholeTitleAtTheLargestTextSize() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port,
                               "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]
        app.launchWithArguments()
        defer { app.terminate() }
        app.openBrowseDestination("inbox.settings")
        let row = app.buttons["settings.machines"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        for _ in 0..<4 where !row.isHittable { app.swipeDown() }
        screenshot("large-settings")

        let title = row.staticTexts["Machines"]
        XCTAssertTrue(title.exists, "the row shows its title")
        // One word on one line is far wider than tall; split across two lines it isn't.
        XCTAssertGreaterThan(title.frame.width, title.frame.height * 2.5, "“Machines” stays one word on one line")
        let value = row.staticTexts.matching(NSPredicate(format: "label MATCHES '[0-9]+'")).firstMatch
        XCTAssertTrue(value.exists, "the row shows how many machines")
        XCTAssertGreaterThanOrEqual(value.frame.minY, title.frame.maxY - 1, "the count sits under the title")
        XCTAssertLessThan(value.frame.minX, title.frame.maxX, "the count starts under the title, not past it")
        // A longer word gets the row's whole width: the glyph steps aside rather than split it.
        let notificationsRow = app.buttons["settings.notifications"]
        for _ in 0..<4 where !notificationsRow.isHittable { app.swipeUp() }
        XCTAssertTrue(notificationsRow.isHittable, "Settings shows Notifications")
        let notifications = notificationsRow.staticTexts["Notifications"]
        XCTAssertTrue(notifications.exists, "the row shows its title")
        XCTAssertGreaterThan(notifications.frame.width, notifications.frame.height * 2.5, "“Notifications” stays whole")
        for _ in 0..<4 where !row.isHittable { app.swipeDown() }

        row.tap()
        let machine = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'machines.row.' AND NOT identifier ENDSWITH '.on' AND NOT identifier ENDSWITH '.off'"))
            .firstMatch
        XCTAssertTrue(machine.waitForExistence(timeout: 20))
        screenshot("large-machines")
    }

    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-large-text-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
