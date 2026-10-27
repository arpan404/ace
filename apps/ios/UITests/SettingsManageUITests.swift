import XCTest

/// Settings' ACP registry, accounts and MCP servers on the spike fixture (`bun run spike:daemon`).
/// `ACE_IOS_SPIKE_PORT` picks the fixture; `ACE_IOS_SHOTS` (a folder) also saves screenshots.
@MainActor final class SettingsManageUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--spike", "--spike-port", ProcessInfo.processInfo.environment["ACE_IOS_SPIKE_PORT"] ?? "9895", "-ace.appearance", "dark"]
        app.launch()
        app.openBrowseDestination("library.providers")
        return app
    }

    func testTheRegistryInstallsAnAgentAndAddsOneByCommand() {
        let app = launch()
        let add = app.buttons["Add agent"]
        XCTAssertTrue(add.waitForExistence(timeout: 20))
        screenshot("providers")
        add.tap()
        let gemini = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Amp'")).firstMatch
        let found = gemini.waitForExistence(timeout: 20)
        screenshot("registry")
        if !found { print("TREE", app.debugDescription) }
        XCTAssertTrue(found)
        let search = app.searchFields.firstMatch
        search.tap()
        search.typeText("zzzz")
        XCTAssertTrue(app.buttons["Add one by command"].waitForExistence(timeout: 10))
        screenshot("registry-no-match")
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4))
        search.typeText("google")
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Gemini CLI'")).firstMatch.waitForExistence(timeout: 10))
        screenshot("registry-search")
        search.buttons["Clear text"].firstMatch.tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Factory Droid'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Install plan"].waitForExistence(timeout: 20))
        screenshot("agent")
        app.buttons["Install"].firstMatch.tap()
        screenshot("agent-installing")
        XCTAssertTrue(app.staticTexts["Installed"].firstMatch.waitForExistence(timeout: 30))
        screenshot("agent-installed")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        let byCommand = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Add by command'")).firstMatch
        for _ in 0..<6 where !byCommand.isHittable { app.swipeDown() }
        byCommand.tap()
        let name = app.textFields["Name"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap(); name.typeText("My agent")
        let command = app.textFields["Command"]
        command.tap(); command.typeText("my-agent --acp")
        // As on the web against a daemon: the page is there, says why, and Add stays off.
        XCTAssertTrue(app.staticTexts["This daemon can't add agents by command yet."].waitForExistence(timeout: 10))
        let matches = app.buttons.matching(identifier: "Add agent")
        XCTAssertFalse(matches.element(boundBy: max(matches.count - 1, 0)).isEnabled)
        screenshot("manual")
    }

    func testAnAccountsBadgeChangesAsItIsEditedAndRemoveOffersItsFiles() {
        let app = launch()
        let codex = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Codex'")).firstMatch
        XCTAssertTrue(codex.waitForExistence(timeout: 20))
        codex.tap()
        app.buttons["Accounts"].firstMatch.tap()
        let edit = app.buttons["Edit name and badge"].firstMatch
        XCTAssertTrue(edit.waitForExistence(timeout: 20))
        screenshot("accounts")
        let keyLine = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Add an API key in ace on'")).firstMatch
        for _ in 0..<5 where !keyLine.exists { app.swipeUp() }
        XCTAssertTrue(keyLine.exists)
        screenshot("accounts-api-key-line")
        for _ in 0..<5 where !edit.isHittable { app.swipeDown() }
        edit.tap()
        XCTAssertTrue(app.textFields["Badge letters"].waitForExistence(timeout: 10))
        screenshot("badge-editor")
        app.buttons["Use rocket badge"].tap()
        app.buttons["Violet"].tap()
        screenshot("badge-editor-rocket")
        app.buttons["Save"].tap()
        XCTAssertTrue(edit.waitForExistence(timeout: 10))
        screenshot("accounts-after-badge")

        let remove = app.buttons["Remove account"].firstMatch
        for _ in 0..<3 where !remove.isHittable { app.swipeUp() }
        remove.tap()
        XCTAssertTrue(app.buttons["Remove and delete its files"].waitForExistence(timeout: 10))
        screenshot("remove-confirm")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()

        let addAccount = app.buttons["Add account"].firstMatch
        for _ in 0..<4 where !addAccount.isHittable { app.swipeUp() }
        addAccount.tap()
        XCTAssertTrue(app.buttons["Sign in with the browser"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Use OpenAI API key"].exists)
        let label = app.textFields["Account name"]
        label.tap(); label.typeText("Side")
        screenshot("add-account")
        app.buttons["Add"].tap()
        XCTAssertFalse(app.secureTextFields["API key"].waitForExistence(timeout: 5))
        screenshot("add-account-sign-in")
        app.buttons["Done"].tap()
    }

    func testProviderMcpServersTurnOffAndAddACommandServer() {
        let app = launch()
        let codex = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Codex'")).firstMatch
        XCTAssertTrue(codex.waitForExistence(timeout: 20))
        codex.tap()
        app.buttons["MCP servers"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["vercel"].waitForExistence(timeout: 20))
        screenshot("mcp")
        app.buttons.matching(identifier: "Turn off").element(boundBy: 1).tap()
        XCTAssertTrue(app.staticTexts["Off"].waitForExistence(timeout: 10))
        screenshot("mcp-off")
        app.buttons["Add MCP server"].tap()
        let name = app.textFields["Name"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        name.tap(); name.typeText("files")
        let command = app.textFields.element(boundBy: 1)
        command.tap(); command.typeText("npx -y server-files \"/Users/ada/My Docs\"")
        screenshot("mcp-add")
        app.buttons["Add"].tap()
        XCTAssertTrue(app.staticTexts["files"].waitForExistence(timeout: 15))
        screenshot("mcp-added")
    }

    private func screenshot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = "ios-settings-\(name)"
        attachment.lifetime = .keepAlways
        add(attachment)
        if let folder = ProcessInfo.processInfo.environment["ACE_IOS_SHOTS"] {
            try? shot.pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name).png"))
        }
    }
}
