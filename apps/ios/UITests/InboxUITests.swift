import XCTest

/// The inbox against the local spike fixture: the Snoozed shelf, swipe actions, undo and offline.
@MainActor final class InboxUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    func testShelvesSwipesAndUndo() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launchWithArguments()
        app.revealRow("thread.ios-tree")
        screenshot("inbox")
        // Snoozed threads wait on the Snoozed tab, out of the Inbox.
        XCTAssertFalse(app.buttons["thread.ios-snoozed"].exists)
        let inboxTab = app.buttons["threads.tab.inbox"].firstMatch
        let snoozedTab = app.buttons["threads.tab.snoozed"].firstMatch
        let settledTab = app.buttons["threads.tab.settled"].firstMatch
        app.tapThreadsTab(snoozedTab)
        XCTAssertTrue(app.buttons["thread.ios-snoozed"].waitForExistence(timeout: 10))
        screenshot("inbox-snoozed")
        app.tapThreadsTab(inboxTab)

        // Trailing swipe: Snooze asks until when; a snoozed row offers Wake instead.
        let tree = app.buttons["thread.ios-tree"]
        app.bringToMiddle(tree)
        tree.swipeLeft()
        XCTAssertTrue(app.buttons["Snooze"].waitForExistence(timeout: 5))
        app.buttons["Snooze"].tap()
        XCTAssertTrue(app.buttons["1 hour"].waitForExistence(timeout: 5))
        screenshot("inbox-snooze")
        app.buttons["1 hour"].tap()
        // The snoozed row leaves the Inbox for the Snoozed tab, where it says when it wakes. A row
        // the lazy list unloaded also "leaves", so the proof is finding it on the Snoozed tab.
        XCTAssertTrue(tree.waitForNonExistence(timeout: 15))
        app.tapThreadsTab(snoozedTab)
        app.bringToMiddle(tree)
        XCTAssertTrue(tree.waitForExistence(timeout: 15), "the snoozed thread is on the Snoozed tab")
        XCTAssertTrue(tree.label.contains("Until"), tree.label)
        // The Snoozed list is short and its rows sit right under the tabs: dragging it would only
        // pull to refresh.
        if !tree.isHittable { app.bringToMiddle(tree) }
        tree.swipeLeft()
        XCTAssertTrue(app.buttons["Wake"].waitForExistence(timeout: 5))
        app.buttons["Wake"].tap()
        XCTAssertTrue(tree.waitForNonExistence(timeout: 10), "awake, it leaves Snoozed")
        app.tapThreadsTab(inboxTab)

        // Settle moves a finished thread off the list; Undo, inside its five seconds, brings it back.
        let done = app.buttons["thread.ios-done"]
        app.bringToMiddle(done)
        done.swipeLeft()
        XCTAssertTrue(app.buttons["Settle"].waitForExistence(timeout: 5))
        app.buttons["Settle"].tap()
        let undoSettle = app.buttons["inbox.undoSettle"]
        XCTAssertTrue(undoSettle.waitForExistence(timeout: 10))
        XCTAssertTrue(done.waitForNonExistence(timeout: 10))
        undoSettle.tap()
        XCTAssertTrue(done.waitForExistence(timeout: 10))

        // Left alone, the toast goes and the thread waits on the Settled tab, which unsettles it.
        app.bringToMiddle(done)
        done.swipeLeft()
        XCTAssertTrue(app.buttons["Settle"].waitForExistence(timeout: 5))
        app.buttons["Settle"].tap()
        XCTAssertTrue(undoSettle.waitForExistence(timeout: 10))
        XCTAssertTrue(undoSettle.waitForNonExistence(timeout: 10), "the Undo toast goes by itself")
        app.tapThreadsTab(settledTab)
        screenshot("inbox-settled")
        app.bringToMiddle(done)
        XCTAssertTrue(done.isHittable, "the settled thread is on the Settled tab")
        done.swipeLeft()
        XCTAssertTrue(app.buttons["Unsettle"].waitForExistence(timeout: 5))
        app.buttons["Unsettle"].tap()
        XCTAssertTrue(done.waitForNonExistence(timeout: 10), "unsettled, it leaves Settled")
        app.tapThreadsTab(inboxTab)
        XCTAssertTrue(done.waitForExistence(timeout: 10))

        // The leading swipe pins; Archive lives in the long-press menu, with its own Undo.
        app.bringToMiddle(done)
        done.swipeRight()
        XCTAssertTrue(app.buttons["Pin"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Archive"].exists, "the leading swipe only pins")
        done.swipeLeft()
        done.press(forDuration: 1.0)
        XCTAssertTrue(app.buttons["Archive"].waitForExistence(timeout: 5))
        app.buttons["Archive"].tap()
        XCTAssertTrue(app.buttons["inbox.undoArchive"].waitForExistence(timeout: 10))
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: done)
        wait(for: [gone], timeout: 10)
        screenshot("inbox-archived")
        app.buttons["inbox.undoArchive"].tap()
        XCTAssertTrue(done.waitForExistence(timeout: 10))
    }

    /// A waiting approval answers from the inbox without opening: the trailing swipe's Allow once
    /// allows it, and the long-press menu's Deny denies another, as the machine records them. Each
    /// row stops waiting once its request closes. Both threads are seeded for this test alone.
    func testSwipeAllowsAWaitingApprovalAndTheMenuDeniesOne() throws {
        let port = ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"
        let allowed = try fresh("approval", port: port)
        let denied = try fresh("approval", port: port)
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port]
        app.launchWithArguments()
        // The fixture build asks for notifications on first launch.
        let prompt = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
        if prompt.waitForExistence(timeout: 3) { prompt.tap() }
        // The row shows the command it waits on; it has no buttons of its own.
        let command = "git push origin fix/queue"
        let row = app.revealRow("thread.\(allowed)")
        XCTAssertTrue(row.label.contains(command), row.label)
        XCTAssertFalse(row.buttons["inbox.need.allow_once"].exists, "the row answers by swipe, not by an in-row button")
        screenshot("inbox-waiting")
        row.swipeLeft()
        let allow = app.buttons["Allow once"]
        XCTAssertTrue(allow.waitForExistence(timeout: 5))
        screenshot("inbox-swipe-allow")
        allow.tap()
        XCTAssertEqual(decision(allowed, port: port), "allow_once", "the swipe's Allow once allowed this request")
        wait(for: [expectation(for: NSPredicate(format: "NOT (label CONTAINS %@)", command), evaluatedWith: row)], timeout: 15)

        let other = app.revealRow("thread.\(denied)")
        XCTAssertTrue(other.label.contains(command), other.label)
        other.press(forDuration: 1.0)
        let deny = app.buttons["Deny"]
        XCTAssertTrue(deny.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Allow once"].exists, "the menu offers both answers")
        deny.tap()
        XCTAssertEqual(decision(denied, port: port), "deny", "the menu's Deny denied this request")
        wait(for: [expectation(for: NSPredicate(format: "NOT (label CONTAINS %@)", command), evaluatedWith: other)], timeout: 15)
    }

    /// How the machine answered the thread's approval, as the kind of the option it recorded
    /// ("allow_once", "deny"), read from the fixture's thread state (`GET /state`) until the
    /// request closes; nil if it never does within 15 s.
    private func decision(_ threadId: String, port: String) -> String? {
        for _ in 0..<30 {
            if let kind = recorded(threadId, port: port) { return kind }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return nil
    }
    private func recorded(_ threadId: String, port: String) -> String? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/state?thread=\(threadId)"),
              let data = fetch(URLRequest(url: url)),
              let view = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let interactions = view["interactions"] as? [String: Any] else { return nil }
        for case let interaction as [String: Any] in interactions.values {
            guard let request = interaction["request"] as? [String: Any], request["kind"] as? String == "approval",
                  interaction["state"] as? String != "pending",
                  let chosen = (interaction["resolution"] as? [String: Any])?["optionId"] as? String,
                  let options = request["options"] as? [[String: Any]] else { continue }
            return options.first { $0["id"] as? String == chosen }?["kind"] as? String
        }
        return nil
    }

    /// A new thread from the fixture for one test, so answering it never changes another's.
    private func fresh(_ scenario: String, port: String) throws -> String {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/review/fresh")))
        request.httpMethod = "POST"
        request.httpBody = try JSONEncoder().encode(["scenario": scenario])
        let body = fetch(request).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) }
        return try XCTUnwrap(body?["threadId"], "the fixture made no \(scenario) thread")
    }
    /// One request to the fixture, waited for; nil when it fails.
    private func fetch(_ request: URLRequest) -> Data? {
        let done = expectation(description: "fixture reply")
        let reply = FixtureReply()
        URLSession.shared.dataTask(with: request) { data, _, _ in
            reply.data = data
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return reply.data
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

/// The fixture's reply, written once by the request's callback before the test reads it.
private final class FixtureReply: @unchecked Sendable { var data: Data? }
