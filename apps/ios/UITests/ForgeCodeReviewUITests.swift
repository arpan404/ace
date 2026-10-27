import XCTest

/// Reviewing a pull request's code on the spike fixture (`bun run spike:daemon`): #245 in
/// acme/ace has four commits, and its Files changed are settings-page.tsx (0), section.tsx (1),
/// save-bar.tsx (2, two changes, pushed to after it was viewed), docs/settings.md (3, viewed)
/// and settings-hero.png (4, no patch, two versions). `ACE_IOS_SPIKE_PORT` picks the fixture;
/// `ACE_IOS_SHOTS` (a folder) also saves each screenshot there.
@MainActor final class ForgeCodeReviewUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    func testCommitsListOpensOneCommitsFiles() {
        let app = openPull()
        let commits = app.buttons["forge.pull.commits"]
        app.reveal(commits)
        commits.tap()
        let third = app.buttons["forge.commit.2"]
        XCTAssertTrue(third.waitForExistence(timeout: 20))
        screenshot("commits")
        third.tap()
        let range = element(app, "forge.files.range")
        XCTAssertTrue(range.waitForExistence(timeout: 20))
        XCTAssertEqual(range.label, "Describe the save bar in the settings guide")
        XCTAssertTrue(app.buttons["forge.files.1"].waitForExistence(timeout: 10), "The commit's two files")
        XCTAssertFalse(app.buttons["forge.files.2"].exists)
        screenshot("commit-files")
    }

    func testComparingTwoCommitsShowsWhatChangedBetweenThem() {
        let app = openFiles()
        app.buttons["forge.files.change"].tap()
        let compare = app.buttons["forge.commits.compare"]
        XCTAssertTrue(compare.waitForExistence(timeout: 20))
        compare.tap()
        app.buttons["forge.commit.0"].tap()
        screenshot("compare-start")
        app.buttons["forge.commit.3"].tap()
        let range = element(app, "forge.files.range")
        let label = expectation(for: NSPredicate(format: "label == '3 commits after c111111'"), evaluatedWith: range)
        wait(for: [label], timeout: 20)
        XCTAssertTrue(app.buttons["forge.files.2"].waitForExistence(timeout: 10))
        screenshot("compare-files")
    }

    func testChangesSinceYourLastReviewShowOnlyTheNewCommits() {
        let app = openFiles()
        app.buttons["forge.files.change"].tap()
        let since = app.buttons["forge.commits.since-review"]
        XCTAssertTrue(since.waitForExistence(timeout: 20))
        screenshot("since-review-choice")
        since.tap()
        let range = element(app, "forge.files.range")
        let label = expectation(for: NSPredicate(format: "label == '2 commits after c222222'"), evaluatedWith: range)
        wait(for: [label], timeout: 20)
        screenshot("since-review-files")
    }

    func testAFilePushedToSinceItWasViewedSaysSoAndCanBeMarkedViewedAgain() {
        let app = openFiles()
        let mark = element(app, "forge.files.viewed.2")
        XCTAssertTrue(mark.waitForExistence(timeout: 20))
        XCTAssertEqual(mark.label, "Changed since viewed")
        XCTAssertEqual(element(app, "forge.files.viewed.3").label, "Viewed")
        screenshot("viewed-marks")
        app.buttons["forge.files.2"].tap()
        let viewed = app.buttons["forge.code.viewed"]
        XCTAssertTrue(viewed.waitForExistence(timeout: 20))
        viewed.tap()
        let done = expectation(for: NSPredicate(format: "value == 'Viewed'"), evaluatedWith: viewed)
        wait(for: [done], timeout: 20)
        screenshot("marked-viewed")
        app.tapBack()
        let again = expectation(for: NSPredicate(format: "label == 'Viewed'"), evaluatedWith: element(app, "forge.files.viewed.2"))
        wait(for: [again], timeout: 20)
    }

    func testCommentOnASpanOfLinesWaitsInTheReview() {
        let app = openFile(2)
        let start = app.buttons["forge.line.RIGHT.5"]
        XCTAssertTrue(start.waitForExistence(timeout: 20))
        start.tap()
        app.buttons["forge.pick.extend"].tap()
        app.buttons["forge.line.RIGHT.7"].tap()
        XCTAssertEqual(element(app, "forge.pick.label").label, "Lines 5–7")
        screenshot("span-picked")
        app.buttons["forge.pick.comment"].tap()
        let box = app.textFields["forge.editor"].firstMatch
        XCTAssertTrue(box.waitForExistence(timeout: 10))
        box.tap()
        box.typeText("Name the inset after the keyboard.")
        screenshot("span-comment")
        app.buttons["forge.write.primary"].tap()
        XCTAssertTrue(app.staticTexts["Pending"].waitForExistence(timeout: 20))
        screenshot("span-pending")
    }

    func testMarkdownReadsRenderedAndSwitchesToItsSource() {
        let app = openFile(3)
        XCTAssertTrue(element(app, "forge.rendered.1").waitForExistence(timeout: 20))
        screenshot("rendered-diff")
        app.buttons["forge.code.rendered"].tap()
        XCTAssertTrue(app.buttons["forge.line.RIGHT.3"].waitForExistence(timeout: 10))
        screenshot("markdown-source")
    }

    func testAScreenshotShowsBothVersionsSideBySideAndBySwipe() {
        let app = openFile(4)
        let layout = element(app, "forge.image.layout")
        XCTAssertTrue(layout.waitForExistence(timeout: 30))
        screenshot("image-side-by-side")
        layout.buttons["Swipe"].tap()
        let slider = app.sliders["forge.image.swipe"]
        XCTAssertTrue(slider.waitForExistence(timeout: 10))
        slider.adjust(toNormalizedSliderPosition: 0.25)
        screenshot("image-swipe")
    }

    func testLinesCanRunUnwrapped() {
        let app = openFile(2)
        let wrap = app.buttons["forge.code.wrap"]
        XCTAssertTrue(wrap.waitForExistence(timeout: 20))
        screenshot("wrapped")
        wrap.tap()
        XCTAssertTrue(app.buttons["forge.line.RIGHT.9"].waitForExistence(timeout: 10))
        screenshot("unwrapped")
        wrap.tap()
    }

    private func openPull() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841"]
        app.launch()
        XCTAssertTrue(app.buttons["inbox.settings"].waitForExistence(timeout: 25))
        app.openPulls()
        let row = app.buttons["forge.pull.245"]
        XCTAssertTrue(row.waitForExistence(timeout: 25))
        row.tap()
        XCTAssertTrue(element(app, "forge.pull.header").waitForExistence(timeout: 20))
        return app
    }
    private func openFiles() -> XCUIApplication {
        let app = openPull()
        let files = app.buttons["forge.pull.files"]
        app.reveal(files)
        files.tap()
        XCTAssertTrue(app.buttons["forge.files.4"].waitForExistence(timeout: 20))
        return app
    }
    private func openFile(_ index: Int) -> XCUIApplication {
        let app = openFiles()
        let file = app.buttons["forge.files.\(index)"]
        app.reveal(file)
        file.tap()
        return app
    }
    private func element(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }
    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-forge-code-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("forge-code-\(name).png"))
        }
    }
}
