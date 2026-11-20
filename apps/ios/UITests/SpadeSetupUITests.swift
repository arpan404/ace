import XCTest

/// New bot and Settings › Spade on the spike fixture (`scripts/spade-scenario.ts`): a bot made
/// from one message opens on its conversation, and a key typed into Models and keys goes to the
/// machine's keychain without ever showing. Each also saves its screens in light and dark.
extension SpadeUITests {
    func testANewBotStartsFromOneMessageAndOpensOnItsConversation() {
        let app = launch(appearance: "dark")
        _ = openSpade(app)
        let new = app.buttons["spade.newBot"]
        XCTAssertTrue(new.waitForExistence(timeout: 20))
        new.tap()
        let field = app.textFields["spade.newbot.field"].exists ? app.textFields["spade.newbot.field"] : app.textViews["spade.newbot.field"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        // The machine's templates show under the question.
        XCTAssertTrue(app.buttons["spade.newbot.template.reviewer"].waitForExistence(timeout: 10))
        field.typeText("Watch the release branch and tell me when CI goes red")
        screenshot("spade-newbot-dark")

        app.buttons["spade.newbot.create"].tap()
        XCTAssertTrue(app.staticTexts["Watch the release branch and tell me when CI goes red"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.descendants(matching: .any)["spade.newbot.sheet"].exists)
    }

    func testAKeyTypedInModelsAndKeysGoesToTheKeychainAndIsNeverShown() {
        let app = launch(appearance: "light")
        _ = openSpade(app)
        let settings = app.buttons["spade.openSettings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 20))
        settings.tap()
        screenshot("spade-settings-light")

        app.buttons["spade.settings.general"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["spade.settings.model.new_bot"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.switches["spade.settings.run"].exists)
        screenshot("spade-general-light")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        app.buttons["spade.settings.models"].tap()
        let key = app.descendants(matching: .any)["spade.settings.key.openrouter"]
        XCTAssertTrue(key.waitForExistence(timeout: 15))
        XCTAssertTrue(key.label.contains("Not set"), key.label)
        screenshot("spade-models-light")

        key.tap()
        app.buttons["Add key"].firstMatch.tap()
        let secret = app.secureTextFields["spade.key.field"]
        XCTAssertTrue(secret.waitForExistence(timeout: 10))
        secret.typeText("sk-or-ui-test-secret")
        app.buttons["spade.key.save"].tap()
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "In keychain"))
            .matching(identifier: "spade.settings.key.openrouter").firstMatch.waitForExistence(timeout: 15))
        XCTAssertFalse(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@",
                                                                             "sk-or-ui", "sk-or-ui")).firstMatch.exists)
    }

    /// The same screens in the other look, for the PR's before and after.
    func testSpadeSettingsAndNewBotInTheOtherLook() {
        let app = launch(appearance: "light")
        _ = openSpade(app)
        XCTAssertTrue(app.buttons["spade.newBot"].waitForExistence(timeout: 20))
        screenshot("spade-list-light")
        app.buttons["spade.newBot"].tap()
        XCTAssertTrue(app.buttons["spade.newbot.template.reviewer"].waitForExistence(timeout: 10))
        screenshot("spade-newbot-light")
        app.buttons["spade.newbot.cancel"].tap()

        let dark = launch(appearance: "dark")
        _ = openSpade(dark)
        XCTAssertTrue(dark.buttons["spade.openSettings"].waitForExistence(timeout: 20))
        screenshot("spade-list-dark")
        dark.buttons["spade.openSettings"].tap()
        screenshot("spade-settings-dark")
        dark.buttons["spade.settings.general"].tap()
        XCTAssertTrue(dark.descendants(matching: .any)["spade.settings.model.new_bot"].waitForExistence(timeout: 15))
        screenshot("spade-general-dark")
        dark.navigationBars.buttons.element(boundBy: 0).tap()
        dark.buttons["spade.settings.models"].tap()
        XCTAssertTrue(dark.descendants(matching: .any)["spade.settings.key.openrouter"].waitForExistence(timeout: 15))
        screenshot("spade-models-dark")
    }
}
