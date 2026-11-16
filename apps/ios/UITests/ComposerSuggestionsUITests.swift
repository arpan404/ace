import XCTest

/// The thread composer's `@`, `/` and + lists against the spike fixture, with screenshots. Run on
/// a fresh fixture; `TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port.
@MainActor final class ComposerSuggestionsUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testMentionsCommandsAndTheAddListInAThread() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launchWithArguments()
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Don’t Allow"]
        if alert.waitForExistence(timeout: 5) { alert.tap() }
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "thread.")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        row.tap()
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 25))
        input.tap()

        // `@` lists files; typing narrows them; picking inserts the file's reference.
        input.typeText("Look at @")
        let list = app.descendants(matching: .any)["composer.suggestions"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        input.typeText("READ")
        let readme = app.buttons["composer.suggestion.file:README.md"]
        XCTAssertTrue(readme.waitForExistence(timeout: 10))
        screenshot("composer-mention")
        readme.tap()
        XCTAssertTrue(list.waitForNonExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "Look at @README.md ")

        // `/` lists the catalog.
        input.typeText("/")
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "composer.suggestion.entry:")).firstMatch
            .waitForExistence(timeout: 15))
        screenshot("composer-command")
        // Deleting the `/` closes it.
        input.typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertTrue(list.waitForNonExistence(timeout: 5))

        // + offers the phone's sources and the catalog's builtins.
        app.buttons["composer.attach"].tap()
        XCTAssertTrue(app.buttons["Photo library"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["composer.add.files"].waitForExistence(timeout: 10))
        screenshot("composer-add")
        app.buttons["composer.add.files"].tap()
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        screenshot("composer-add-files")
    }

    /// A `/` list opens over the transcript: the pills step aside and the composer stays where it
    /// was, so the foot's height never changes.
    func testACommandListOpensOverTheTranscriptWithoutMovingTheComposer() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launchWithArguments()
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Don’t Allow"]
        if alert.waitForExistence(timeout: 5) { alert.tap() }
        app.revealRow("thread.ios-waiting").tap()
        let live = app.descendants(matching: .any)["composer.live"]
        XCTAssertTrue(live.waitForExistence(timeout: 25))
        // The live subagents are the pill's while it shows: no group row in the transcript.
        let group = app.buttons["subagents.rollup"]
        XCTAssertTrue(group.waitForNonExistence(timeout: 5), "the pill says the live subagents")
        let input = app.textViews["composer.input"]
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        sleep(1)
        let rest = input.frame.minY
        input.typeText("/")
        let list = app.descendants(matching: .any)["composer.suggestions"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        sleep(1)
        XCTAssertFalse(live.exists, "the pills step aside while the list is open")
        // With no pill on screen the transcript says the live subagents again, never neither.
        XCTAssertTrue(group.waitForExistence(timeout: 5), "the live subagents stay in view while the list is open")
        XCTAssertEqual(input.frame.minY, rest, accuracy: 1, "the composer stays where it was")
        XCTAssertLessThanOrEqual(list.frame.maxY, input.frame.minY, "the list sits above the capsule")
        screenshot("composer-command-over-transcript")
        input.typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertTrue(list.waitForNonExistence(timeout: 5))
        XCTAssertTrue(live.waitForExistence(timeout: 5), "the pills come back once the list closes")
        XCTAssertTrue(group.waitForNonExistence(timeout: 5), "and the pill says the live subagents again")
        XCTAssertEqual(input.frame.minY, rest, accuracy: 1, "and the composer hasn't moved")

        // A row picked from the list over the transcript lands in the field.
        input.typeText("@READ")
        let readme = app.buttons["composer.suggestion.file:README.md"]
        XCTAssertTrue(readme.waitForExistence(timeout: 10))
        XCTAssertTrue(readme.isHittable, "the list's rows take taps over the transcript")
        readme.tap()
        XCTAssertTrue(list.waitForNonExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "@README.md ")
        // With the list gone, a tap on the transcript reaches it again: it puts the keyboard away.
        app.scrollViews["transcript"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "a transcript tap after the list closed")
    }

    /// An approval that arrives while the `/` list is open shows above the composer, and the list
    /// opens above it rather than over it: Allow stays in reach.
    func testAnApprovalArrivingWhileTheCommandListIsOpenStaysAnswerable() throws {
        let threadId = try fixture("/review/fresh", ["scenario": "stop"])["threadId"]
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port, "--spike-open", try XCTUnwrap(threadId)]
        app.launchWithArguments()
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.buttons["Allow"]
        if alert.waitForExistence(timeout: 3) { alert.tap() }
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 25))
        input.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        input.typeText("/")
        let list = app.descendants(matching: .any)["composer.suggestions"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        _ = try fixture("/review/ask", ["threadId": try XCTUnwrap(threadId)])
        let allow = app.buttons["approval.allow_once"]
        XCTAssertTrue(allow.waitForExistence(timeout: 15), "the approval arrives above the composer")
        sleep(1)
        XCTAssertTrue(list.exists, "the list stays open as the approval arrives")
        XCTAssertTrue(allow.isHittable, "the list never covers the approval's Allow")
        XCTAssertLessThanOrEqual(list.frame.maxY, allow.frame.minY, "the list opens above the strip")
        screenshot("composer-command-above-approval")
        allow.tap()
        XCTAssertTrue(allow.waitForNonExistence(timeout: 10), "Allow answers the approval")
    }

    private var port: String { ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841" }

    /// Posts to the fixture's control route and returns its JSON reply.
    private func fixture(_ path: String, _ body: [String: String]) throws -> [String: String] {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)\(path)")))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let done = expectation(description: "fixture \(path)")
        let reply = FixtureReply()
        URLSession.shared.dataTask(with: request) { data, response, _ in
            reply.status = (response as? HTTPURLResponse)?.statusCode
            if let data { reply.body = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?.compactMapValues { $0 as? String } ?? [:] }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        XCTAssertEqual(reply.status, 200, "the fixture took \(path)")
        return reply.body
    }

    func testNewThreadMentionsFilesAndOffersItsBuiltins() {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launchWithArguments()
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Don’t Allow"]
        if alert.waitForExistence(timeout: 5) { alert.tap() }
        XCTAssertTrue(app.newThreadButton.waitForExistence(timeout: 25))
        app.newThreadButton.tap()
        XCTAssertTrue(app.buttons["newThread.project"].waitForExistence(timeout: 10))
        app.buttons["newThread.project"].tap()
        XCTAssertTrue(app.buttons["project.ace"].waitForExistence(timeout: 15))
        app.buttons["project.ace"].tap()
        let message = app.descendants(matching: .any)["newThread.message"].firstMatch
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        message.tap()
        message.typeText("Read @")
        let list = app.descendants(matching: .any)["composer.suggestions"]
        XCTAssertTrue(list.waitForExistence(timeout: 10))
        let file = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "composer.suggestion.file:")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 15))
        screenshot("newthread-mention")
        file.tap()
        XCTAssertTrue(list.waitForNonExistence(timeout: 5))
        XCTAssertTrue((message.value as? String)?.hasPrefix("Read @") == true)
        app.buttons["newThread.attach"].tap()
        XCTAssertTrue(app.buttons["composer.add.files"].waitForExistence(timeout: 10))
        screenshot("newthread-add")
    }

    private func screenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

private final class FixtureReply: @unchecked Sendable {
    var status: Int?
    var body: [String: String] = [:]
}
