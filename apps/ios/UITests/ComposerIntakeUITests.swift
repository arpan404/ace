import XCTest
import UIKit

/// The composer's intake and recall against the spike fixture: Previous message in +, an image
/// pasted into the message, and lines selected in the file viewer mentioned in the message.
/// `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a folder) also saves each screenshot
/// there as `intake-<name>.png`.
@MainActor final class ComposerIntakeUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testPreviousMessagePutsWhatWasSentBackInTheComposer() throws {
        let app = launch(into: "ios-limited")
        app.buttons["composer.attach"].tap()
        let recall = app.buttons.matching(NSPredicate(format: "identifier == 'composer.recall' OR label == 'Previous message'")).firstMatch
        XCTAssertTrue(recall.waitForExistence(timeout: 5))
        screenshot("plus-menu")
        recall.tap()
        let input = app.textViews["composer.input"]
        let recalled = NSPredicate(format: "value CONTAINS 'Profile the search indexer'")
        wait(for: [expectation(for: recalled, evaluatedWith: input)], timeout: 10)
        screenshot("recalled")
    }

    func testAPastedImageGoesOnTheMessage() throws {
        let app = launch(into: "ios-limited")
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64))
        UIPasteboard.general.image = renderer.image { context in
            UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        }
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        input.press(forDuration: 1.0)
        let paste = app.menuItems["Paste"].firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 5))
        paste.tap()
        let allow = app.alerts.buttons["Allow Paste"].firstMatch
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        XCTAssertTrue(app.descendants(matching: .any)["composer.media"].waitForExistence(timeout: 15))
        screenshot("pasted")
    }

    func testALongPasteGoesAsATextFileAndCanGoBackAsText() throws {
        let app = launch(into: "ios-limited")
        UIPasteboard.general.string = (1...60).map { "log line \($0)" }.joined(separator: "\n")
        let input = pasteIntoComposer(app)
        let chip = app.descendants(matching: .any).matching(identifier: "composer.attachment")
            .matching(NSPredicate(format: "label CONTAINS 'Pasted 60 lines.txt'")).firstMatch
        XCTAssertTrue(chip.waitForExistence(timeout: 15))
        XCTAssertFalse((input.value as? String ?? "").contains("log line 1"))
        screenshot("long-paste")
        chip.press(forDuration: 1.0)
        let asText = app.buttons["Paste as Text"].firstMatch
        XCTAssertTrue(asText.waitForExistence(timeout: 5))
        asText.tap()
        let restored = NSPredicate(format: "value CONTAINS 'log line 60'")
        wait(for: [expectation(for: restored, evaluatedWith: input)], timeout: 10)
        XCTAssertTrue(chip.waitForNonExistence(timeout: 10))
        screenshot("long-paste-as-text")
    }

    func testAShortPasteGoesInAsWords() throws {
        let app = launch(into: "ios-limited")
        UIPasteboard.general.string = "npm run build"
        let input = pasteIntoComposer(app)
        let pasted = NSPredicate(format: "value CONTAINS 'npm run build'")
        wait(for: [expectation(for: pasted, evaluatedWith: input)], timeout: 10)
        XCTAssertFalse(app.descendants(matching: .any)["composer.attachment"].exists)
    }

    func testSelectedLinesAreMentionedInTheMessage() throws {
        let app = launch(into: "ios-files")
        app.buttons["thread.menu"].tap()
        app.threadMenuItem("thread.files").tap()
        let outbox = app.buttons["file.apps/web/src/relay/outbox.ts"]
        XCTAssertTrue(outbox.waitForExistence(timeout: 15))
        outbox.tap()
        let text = app.descendants(matching: .any)["preview.text"].firstMatch
        XCTAssertTrue(text.waitForExistence(timeout: 15))
        text.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.12)).doubleTap()
        let mention = app.buttons["preview.mentionLines"]
        XCTAssertTrue(mention.waitForExistence(timeout: 5))
        XCTAssertTrue(mention.label.hasPrefix("Mention line"))
        screenshot("lines-selected")
        mention.tap()
        let input = app.textViews["composer.input"]
        let mentioned = NSPredicate(format: "value CONTAINS '@apps/web/src/relay/outbox.ts:'")
        wait(for: [expectation(for: mentioned, evaluatedWith: input)], timeout: 10)
        screenshot("lines-mentioned")
    }

    private func launch(into thread: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        app.revealRow("thread.\(thread)").tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
        return app
    }
    /// Pastes the pasteboard into the composer from its edit menu.
    private func pasteIntoComposer(_ app: XCUIApplication) -> XCUIElement {
        let input = app.textViews["composer.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap()
        input.press(forDuration: 1.0)
        let paste = app.menuItems["Paste"].firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 5))
        paste.tap()
        let allow = app.alerts.buttons["Allow Paste"].firstMatch
        if allow.waitForExistence(timeout: 2) { allow.tap() }
        return input
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-intake-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("intake-\(name).png"))
        }
    }
}
