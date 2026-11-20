import XCTest

/// Profile and the pages Settings links to, against the spike fixture and its fake account
/// backend (`scripts/spike-account.ts`), which logs every Forget, Sign out and Delete it receives.
/// `TEST_RUNNER_ACE_IOS_SHOTS` names a folder to also write each screenshot to.
@MainActor final class AccountUITests: XCTestCase, @unchecked Sendable {
    override func setUp() { continueAfterFailure = false }
    private var port: String { ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9841" }

    func testSettingsOpensTheTermsPrivacyAndSupportPages() throws {
        let app = launch()
        app.openBrowseDestination("inbox.settings")
        XCTAssertTrue(app.buttons["settings.account"].waitForExistence(timeout: 10))
        let support = app.descendants(matching: .any)["settings.support"].firstMatch
        for _ in 0..<8 where !support.isHittable { app.swipeUp() }
        screenshot("settings-legal")
        for (id, page) in [("settings.legal.terms", "https://acehq.dev/terms-of-service/"),
                           ("settings.legal.privacy", "https://acehq.dev/privacy-policy/"),
                           ("settings.support", "https://acehq.dev/support/")] {
            let link = app.descendants(matching: .any)[id].firstMatch
            for _ in 0..<8 where !link.isHittable { app.swipeUp() }
            link.tap()
            XCTAssertEqual(safariAddress(), page, "\(id) opens \(page)")
            app.activate()
            XCTAssertTrue(link.waitForExistence(timeout: 10), "back on Settings")
        }
    }

    func testProfileDeletesTheAccountOnlyWhenConfirmedAndSaysItIsGone() async throws {
        try await accountFixture("/account/reset", method: "POST")
        let app = launch(["--spike-account"])
        app.openBrowseDestination("inbox.settings")
        let profile = app.buttons["settings.account"]
        XCTAssertTrue(profile.waitForExistence(timeout: 10))
        screenshot("settings-account")
        profile.tap()
        XCTAssertTrue(app.descendants(matching: .any)["account.person"].firstMatch.waitForExistence(timeout: 10))
        let delete = app.buttons["account.delete"]
        for _ in 0..<8 where !delete.isHittable { app.swipeUp() }
        XCTAssertTrue(delete.isHittable, "Profile offers Delete account")
        screenshot("profile-delete")

        delete.tap()
        XCTAssertTrue(app.staticTexts["Delete your ace account?"].waitForExistence(timeout: 5))
        screenshot("profile-delete-question")
        dismissDialog(app)
        XCTAssertTrue(app.buttons["account.delete.confirm"].waitForNonExistence(timeout: 5), "Cancel closes the question")
        let afterCancel = try await accountRequests(settling: [])
        XCTAssertEqual(afterCancel, [], "cancelling Delete sends nothing")
        XCTAssertTrue(delete.exists, "still signed in until Delete is confirmed")

        delete.tap()
        let confirm = app.buttons["account.delete.confirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        let deleted = [["kind": "delete"]]
        let afterDelete = try await accountRequests(settling: deleted)
        XCTAssertEqual(afterDelete, deleted, "Delete sends one request")
        let said = app.alerts["Account deleted"].waitForExistence(timeout: 10)
        screenshot("profile-deleted")
        XCTAssertTrue(said, "Profile says the account is gone")
        app.alerts.buttons["OK"].tap()
        let signIn = app.buttons["account.signIn"]
        for _ in 0..<8 where !signIn.exists { app.swipeDown() }
        XCTAssertTrue(signIn.waitForExistence(timeout: 10), "Profile offers Sign in again")
        XCTAssertFalse(app.buttons["account.delete"].exists)
        screenshot("profile-after-delete")
    }

    func testProfileLinksToTheTermsAndPrivacyPagesWebUses() throws {
        let app = launch()
        app.openBrowseDestination("inbox.settings")
        let profile = app.buttons["settings.account"]
        XCTAssertTrue(profile.waitForExistence(timeout: 10))
        profile.tap()
        let privacy = app.descendants(matching: .any)["account.legal.privacy"].firstMatch
        for _ in 0..<8 where !privacy.isHittable { app.swipeUp() }
        XCTAssertTrue(privacy.waitForExistence(timeout: 10))
        XCTAssertEqual(privacy.label, "Privacy policy")
        let terms = app.descendants(matching: .any)["account.legal.terms"].firstMatch
        XCTAssertTrue(terms.exists)
        XCTAssertEqual(terms.label, "Terms of service")
        screenshot("profile-legal")
        for (link, page) in [(terms, "https://acehq.dev/terms-of-service/"), (privacy, "https://acehq.dev/privacy-policy/")] {
            for _ in 0..<8 where !link.isHittable { app.swipeUp() }
            link.tap()
            XCTAssertEqual(safariAddress(), page, "\(link.label) opens \(page)")
            app.activate()
            XCTAssertTrue(link.waitForExistence(timeout: 10), "back on Profile")
        }
    }

    /// Runs against the fixture's fake account backend (`scripts/spike-account.ts`), which logs
    /// every Forget and Sign out it receives.
    func testProfileSendsForgetAndSignOutOnlyWhenConfirmed() async throws {
        try await accountFixture("/account/reset", method: "POST")
        let app = launch(["--spike-account"])
        app.openBrowseDestination("inbox.settings")
        let profile = app.buttons["settings.account"]
        XCTAssertTrue(profile.waitForExistence(timeout: 10))
        profile.tap()
        let person = app.descendants(matching: .any)["account.person"].firstMatch
        XCTAssertTrue(person.waitForExistence(timeout: 10))
        XCTAssertTrue(person.label.contains("Ada Lovelace") && person.label.contains("ada@example.com"), person.label)
        let studio = String(repeating: "S", count: 52)
        let machine = app.descendants(matching: .any)["account.machine.\(studio)"].firstMatch
        XCTAssertTrue(machine.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Machines on your account"].exists)
        screenshot("profile-signed-in")

        askToForget(app, machine)
        screenshot("profile-forget")
        dismissDialog(app)
        XCTAssertTrue(app.buttons["account.machine.forget.confirm"].waitForNonExistence(timeout: 5), "Cancel closes the question")
        let afterCancelledForget = try await accountRequests(settling: [])
        XCTAssertEqual(afterCancelledForget, [], "cancelling Forget sends nothing")
        XCTAssertTrue(machine.exists, "the machine stays until Forget is confirmed")

        askToForget(app, machine)
        // iOS 26 lists a popover's button twice, one inside the other, with one frame.
        app.buttons["account.machine.forget.confirm"].firstMatch.tap()
        let forgot = ["kind": "forget", "hostId": studio]
        let afterForget = try await accountRequests(settling: [forgot])
        XCTAssertEqual(afterForget, [forgot], "Forget sends one request, for studio")
        XCTAssertTrue(machine.waitForNonExistence(timeout: 10), "studio leaves the list")
        XCTAssertTrue(app.descendants(matching: .any)["account.machine.\(String(repeating: "L", count: 52))"].exists)

        let signOut = app.buttons["account.signOut"]
        for _ in 0..<8 where !signOut.isHittable { app.swipeUp() }
        signOut.tap()
        XCTAssertTrue(app.staticTexts["Your threads and drafts stay on this device."].waitForExistence(timeout: 5))
        screenshot("profile-sign-out")
        dismissDialog(app)
        XCTAssertTrue(app.buttons["account.signOut.confirm"].waitForNonExistence(timeout: 5), "Cancel closes the question")
        let afterCancelledSignOut = try await accountRequests(settling: [forgot])
        XCTAssertEqual(afterCancelledSignOut, [forgot], "cancelling Sign out sends nothing")
        XCTAssertTrue(signOut.exists, "still signed in until Sign out is confirmed")

        signOut.tap()
        let confirm = app.buttons["account.signOut.confirm"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
        let signedOut = [forgot, ["kind": "signOut"]]
        let afterSignOut = try await accountRequests(settling: signedOut)
        XCTAssertEqual(afterSignOut, signedOut, "Sign out sends one request")
        let signIn = app.buttons["account.signIn"]
        for _ in 0..<8 where !signIn.exists { app.swipeDown() }
        XCTAssertTrue(signIn.waitForExistence(timeout: 10), "Profile offers Sign in again")
    }

    /// Swipes `machine` and taps Forget, leaving its question up.
    private func askToForget(_ app: XCUIApplication, _ machine: XCUIElement) {
        machine.swipeLeft()
        // A swipe action's button keeps its label, not its identifier.
        let forget = app.buttons["Forget"].firstMatch
        XCTAssertTrue(forget.waitForExistence(timeout: 5), "swiping the row offers Forget")
        forget.tap()
        XCTAssertTrue(app.staticTexts["Forget studio?"].waitForExistence(timeout: 5))
    }

    /// Closes a confirmation dialog without choosing: its Cancel on a phone's action sheet, else a
    /// tap outside the popover, at the screen's left edge halfway down: the popover is centred,
    /// and a notification banner can cover the top of the screen.
    private func dismissDialog(_ app: XCUIApplication) {
        let cancel = app.buttons["Cancel"]
        if cancel.exists && cancel.isHittable { cancel.tap() }
        else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.5)).tap() }
    }

    /// The Forget and Sign out requests the fake account backend has logged, read once they
    /// match `expected` or after 3 seconds, so a request still in flight is counted too.
    private func accountRequests(settling expected: [[String: String]]) async throws -> [[String: String]] {
        var logged: [[String: String]] = []
        for _ in 0..<15 {
            let data = try await accountFixture("/account/requests", method: "GET")
            logged = try JSONDecoder().decode([String: [[String: String]]].self, from: data)["requests"] ?? []
            if logged == expected && !expected.isEmpty { return logged }
            try await Task.sleep(for: .milliseconds(200))
        }
        return logged
    }
    @discardableResult private func accountFixture(_ path: String, method: String) async throws -> Data {
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)\(path)")))
        request.httpMethod = method
        return try await URLSession.shared.data(for: request).0
    }

    /// The full address Safari opened, read from its address field: tapping the bar shows the
    /// whole URL where, at rest, it may show only the domain. `https://` is added when Safari
    /// leaves the scheme out. Nil when Safari didn't come forward or no address could be read.
    private func safariAddress() -> String? {
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        guard safari.wait(for: .runningForeground, timeout: 15) else { return nil }
        let bar = safari.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier IN {'URL', 'Address', 'TabBarItemTitle'}")).firstMatch
        guard bar.waitForExistence(timeout: 15) else { return unread(safari) }
        bar.tap()
        let field = safari.textFields.matching(NSPredicate(format: "identifier IN {'URL', 'Address'}")).firstMatch
        guard field.waitForExistence(timeout: 10), let value = field.value as? String, !value.isEmpty else {
            return unread(safari)
        }
        // Leave the address as it was.
        let cancel = safari.buttons["Cancel"]
        if cancel.exists { cancel.tap() }
        return value.hasPrefix("http") ? value : "https://\(value)"
    }

    /// No address could be read: keeps Safari's element tree with the result, to see why.
    private func unread(_ safari: XCUIApplication) -> String? {
        let tree = XCTAttachment(string: safari.debugDescription)
        tree.name = "safari-tree"
        tree.lifetime = .keepAlways
        add(tree)
        return nil
    }

    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", port] + extra
        if let size = ProcessInfo.processInfo.environment["ACE_IOS_TEXT_SIZE"] {
            app.launchArguments += ["-UIPreferredContentSizeCategoryName", size]
        }
        app.launchWithArguments()
        XCTAssertTrue(app.inboxReady.waitForExistence(timeout: 25))
        return app
    }

    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
