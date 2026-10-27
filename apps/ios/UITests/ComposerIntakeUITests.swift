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
