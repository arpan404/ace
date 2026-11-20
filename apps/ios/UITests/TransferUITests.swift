import XCTest

/// Continue on… with two fixture machines (ADR 0101): a moved thread's row, the thread menu, the
/// machine sheet and its Allow projects step, the options, the sending line above the composer,
/// then the new thread on the other machine.
/// Start the first fixture linked to the second, then launch this:
/// `ACE_IOS_SPIKE_PORT=9961 ACE_IOS_SPIKE_MACHINE=1 ACE_IOS_SPIKE_PEER=9962 bun run spike:daemon`.
/// `TEST_RUNNER_ACE_IOS_SPIKE_MACHINES` picks other ports and `TEST_RUNNER_ACE_IOS_SHOTS` a
/// folder for the screenshots. The fixture spends no provider quota.
@MainActor final class TransferUITests: XCTestCase, @unchecked Sendable {
    private var ports: [String] { (ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_MACHINES"] ?? "9961,9962").split(separator: ",").map(String.init) }
    override func setUp() { continueAfterFailure = false }

    func testContinueOnCarriesTheThreadToTheOtherMachineAndOpensItThere() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-machines", ports.joined(separator: ",")]
        app.launchWithArguments()
        let source = "ios-spike-host-\(ports[0])", target = "ios-spike-host-\(ports[1])", name = "studio-\(ports[1])"
        let row = "thread.\(source).ios-done"
        // The Threads list's Inbox control is its readiness: waitForInbox flings a list that
        // opened scrolled back to its top, and revealRow scrolls to the row from there.
        let ready = app.waitForInbox(timeout: 30)
        screenshot("00-launch")
        XCTAssertTrue(ready, "the Threads list never showed:\n\(app.debugDescription.prefix(6000))")

        // A thread whose work moved there (ADR 0191) says so on its row, never its age, and its
        // long-press menu opens it on that machine.
        let moved = app.revealRow("thread.\(source).ios-moved")
        XCTAssertTrue(moved.label.contains("Moved to \(name)"), "the moved row names where its work went: \(moved.label)")
        screenshot("0-moved-row")
        moved.press(forDuration: 1.0)
        // A context menu's items reach XCTest by their words, not their identifiers.
        let openThere = app.buttons["Open on \(name)"].firstMatch
        XCTAssertTrue(openThere.waitForExistence(timeout: 10), "the moved row's menu offers Open on \(name)")
        screenshot("0b-moved-menu")
        // Outside the menu and its preview, beside them: the menu closes and nothing opens.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: openThere)
        wait(for: [gone], timeout: 10)

        app.revealRow(row).tap()

        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
        // The machine's links arrive after it connects; the menu shows what was known when opened.
        let continueOn = app.buttons.matching(NSPredicate(format: "identifier == %@ OR label BEGINSWITH %@", "thread.continueOn", "Continue on")).firstMatch
        for _ in 0..<5 {
            app.buttons["thread.menu"].tap()
            if continueOn.waitForExistence(timeout: 4) { break }
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.9)).tap()
        }
        XCTAssertTrue(continueOn.exists, "a linked machine offers Continue on…")
        wait(for: [expectation(for: NSPredicate(format: "isEnabled == true"), evaluatedWith: continueOn)], timeout: 15)
        screenshot("1-menu")
        continueOn.tap()

        let machine = app.buttons["transfer.machine.\(target)"]
        XCTAssertTrue(machine.waitForExistence(timeout: 15))
        let offline = app.buttons["transfer.machine.ios-spike-away"]
        XCTAssertTrue(offline.exists, "an offline machine stays listed")
        XCTAssertFalse(offline.isEnabled, "and can't be chosen")
        screenshot("2-machines")
        // One that doesn't take this machine's projects says why, with Allow projects where it can.
        let desk = app.buttons["transfer.machine.ios-spike-desk"]
        XCTAssertTrue(desk.isEnabled, "a machine that doesn't take projects can be chosen")
        desk.tap()
        let why = app.staticTexts["transfer.allow.words"].firstMatch
        XCTAssertTrue(why.waitForExistence(timeout: 10))
        XCTAssertTrue(why.label.hasPrefix("Desk doesn't take projects from"), why.label)
        screenshot("2b-allow")
        app.buttons["transfer.back"].tap()
        XCTAssertTrue(machine.waitForExistence(timeout: 10))
        machine.tap()

        let send = app.buttons["transfer.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 10))
        XCTAssertEqual(send.label, "Continue on \(name)")
        XCTAssertEqual(app.switches["transfer.changes"].value as? String, "1", "uncommitted changes come by default")
        screenshot("3-options")
        send.tap()

        let words = app.staticTexts["transfer.words"].firstMatch
        wait(for: [expectation(for: NSPredicate(format: "label BEGINSWITH %@", "Sending to \(name) ·"), evaluatedWith: words)], timeout: 30)
        XCTAssertTrue(app.buttons["transfer.cancel"].firstMatch.exists, "Cancel shows while it sends")
        screenshot("4-sending-sheet")
        app.buttons["transfer.close"].tap()

        // The same line above the composer while the thread's work travels.
        let strip = app.descendants(matching: .any)["thread.transfer"].firstMatch
        XCTAssertTrue(strip.waitForExistence(timeout: 10))
        screenshot("5-sending-line")

        let done = NSPredicate(format: "label == %@", "Continued on \(name)")
        wait(for: [expectation(for: done, evaluatedWith: app.staticTexts["transfer.words"].firstMatch)], timeout: 60)
        XCTAssertFalse(app.buttons["transfer.cancel"].firstMatch.exists)
        let open = app.buttons["transfer.open"].firstMatch
        XCTAssertTrue(open.waitForExistence(timeout: 15), "Open goes to the machine the work is on")
        screenshot("6-done")
        open.tap()

        let from = NSPredicate(format: "label == %@", "Continued from studio-\(ports[0])")
        wait(for: [expectation(for: from, evaluatedWith: app.staticTexts["transfer.words"].firstMatch)], timeout: 20)
        screenshot("7-new-thread")
        app.terminate()
    }

    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-transfer-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("transfer-\(name).png"))
        }
    }
}
