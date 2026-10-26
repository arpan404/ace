import XCTest

/// Pictures in the composer and the full-screen viewer, against the spike fixture's
/// `ios-attachments` thread (`TEST_RUNNER_ACE_IOS_SPIKE_PORT` selects its port). The composer
/// test picks the newest photo in the simulator's library: seed one first with
/// `xcrun simctl addmedia <udid> <image>`.
@MainActor final class MediaViewerUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }

    func testAPickedPhotoShowsAsAThumbnailAndOpensFittedAndZoomable() {
        let app = launchIntoThread()
        app.buttons["composer.attach"].tap()
        let library = app.buttons["Photo Library"]
        XCTAssertTrue(library.waitForExistence(timeout: 10))
        library.tap()
        // The system picker draws out of process; its photos are images in its grid.
        let photo = app.scrollViews.images.firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 20), "the photo picker shows the seeded photo")
        photo.tap()
        let add = app.buttons["Add"]
        if add.waitForExistence(timeout: 3) { add.tap() }
        let thumb = app.buttons["composer.media"].firstMatch
        XCTAssertTrue(thumb.waitForExistence(timeout: 20), "the picked photo shows as a thumbnail in the composer")
        XCTAssertLessThan(thumb.frame.width, 80, "a thumbnail, not the picture at size")
        sleep(1)
        screenshot("composer-thumbnail")
        thumb.tap()
        checkViewer(app, name: "composer")
        XCTAssertTrue(thumb.waitForExistence(timeout: 5), "closing the viewer leaves the photo on the message")
        app.buttons["composer.media.remove"].firstMatch.tap()
        XCTAssertTrue(thumb.waitForNonExistence(timeout: 10), "Remove takes the photo off the message")
    }

    func testASentImageOpensFittedZoomsAndDragsDownToClose() {
        let app = launchIntoThread()
        let sent = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'attachment.image.'")).firstMatch
        XCTAssertTrue(sent.waitForExistence(timeout: 20))
        sent.tap()
        checkViewer(app, name: "sent", close: false)
        // Dragged down at the fitted size, the viewer closes.
        app.descendants(matching: .any)["media.image"].swipeDown(velocity: .fast)
        XCTAssertTrue(app.descendants(matching: .any)["media.image"].waitForNonExistence(timeout: 10))
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 5))
    }

    /// The image fills the screen's width or height inside its bounds, grows with a pinch, toggles
    /// back on a double tap, and Done closes it.
    private func checkViewer(_ app: XCUIApplication, name: String, close: Bool = true) {
        let image = app.descendants(matching: .any)["media.image"]
        XCTAssertTrue(image.waitForExistence(timeout: 20), "the viewer shows the image")
        sleep(1)
        screenshot("\(name)-viewer-fitted")
        let screen = app.windows.firstMatch.frame
        let fitted = image.frame
        XCTAssertTrue(screen.insetBy(dx: -1, dy: -1).contains(fitted), "the image \(fitted) sits within the screen \(screen)")
        let fillsWidth = abs(fitted.width - screen.width) <= 1
        let fillsHeight = abs(fitted.height - screen.height) <= 1
        XCTAssertTrue(fillsWidth || fillsHeight, "the image \(fitted) fills the screen's width or height \(screen)")
        XCTAssertEqual(image.value as? String, "100%")

        image.pinch(withScale: 3, velocity: 2)
        sleep(1)
        screenshot("\(name)-viewer-zoomed")
        XCTAssertGreaterThan(image.frame.width, fitted.width * 1.5, "a pinch zooms in")
        XCTAssertNotEqual(image.value as? String, "100%")

        image.doubleTap()
        sleep(1)
        XCTAssertEqual(image.value as? String, "100%", "a double tap while zoomed goes back to fitted")
        XCTAssertEqual(image.frame.width, fitted.width, accuracy: 1)

        if close {
            app.buttons["media.close"].tap()
            XCTAssertTrue(image.waitForNonExistence(timeout: 10), "Done closes the viewer")
        }
    }

    private func launchIntoThread() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 25))
        // The fixture's first thread asks for notifications once; answer it so it can't cover the screen.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 4) { allow.tap() }
        let row = app.buttons["thread.ios-attachments"]
        for _ in 0..<12 where !row.isHittable { app.swipeUp() }
        row.tap()
        XCTAssertTrue(app.buttons["thread.menu"].waitForExistence(timeout: 15))
        return app
    }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-media-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("media-\(name).png"))
        }
    }
}
