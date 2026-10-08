import XCTest
import ApplicationServices
@testable import ScreenHelper

final class TextInputTests: XCTestCase {
    @MainActor func testUnknownMetadataCannotWriteEvenWithSecureConsent() throws {
        let element = AXUIElementCreateApplication(42)
        var document = "original"
        let input = ValidatedTextInput(destination: { TextDestination(element: element, security: classifyTextMetadata(role: nil, subrole: nil, roleRead: false, subroleRead: false)) },
            replaceSelection: { _, text in document = text; return true }, postCharacter: { document.append($0) })
        XCTAssertThrowsError(try input.type("secret", secureAllowed: true))
        XCTAssertEqual(document, "original")
    }
    @MainActor func testTabCannotNavigateFromAnOrdinaryFieldToAPasswordField() throws {
        let element = AXUIElementCreateApplication(42)
        var password = ""
        let input = ValidatedTextInput(destination: { TextDestination(element: element, security: .ordinary) },
            replaceSelection: { _, text in password = text; return false }, postCharacter: { password.append($0) })
        XCTAssertThrowsError(try input.type("\tsecret", secureAllowed: false))
        XCTAssertEqual(password, "")
    }
    @MainActor func testDestinationIsRevalidatedBetweenUnicodeCharacters() throws {
        let field = AXUIElementCreateApplication(42), password = AXUIElementCreateApplication(43)
        var ordinaryValue = "", secureValue = "", secureFocused = false
        let input = ValidatedTextInput(destination: { TextDestination(element: secureFocused ? password : field, security: secureFocused ? .secure : .ordinary) },
            replaceSelection: { _, _ in false }, postCharacter: { character in
                if secureFocused { secureValue.append(character) } else { ordinaryValue.append(character) }
                secureFocused = true
            })
        XCTAssertThrowsError(try input.type("👋secret", secureAllowed: false))
        XCTAssertEqual(ordinaryValue, "👋")
        XCTAssertEqual(secureValue, "")
    }
    @MainActor func testConsentAllowsSecureSelectionReplacement() throws {
        let field = AXUIElementCreateApplication(42)
        var value = ""
        let input = ValidatedTextInput(destination: { TextDestination(element: field, security: .secure) },
            replaceSelection: { _, text in value = text; return true }, postCharacter: { value.append($0) })
        XCTAssertThrowsError(try input.type("secret", secureAllowed: false))
        XCTAssertEqual(value, "")
        try input.type("secret", secureAllowed: true)
        XCTAssertEqual(value, "secret")
    }
    @MainActor func testFailedSubroleReadCannotMutateAnApparentlyOrdinaryField() throws {
        let element = AXUIElementCreateApplication(42)
        var document = "original"
        let input = ValidatedTextInput(destination: { TextDestination(element: element, security: classifyTextMetadata(role: "AXTextField", subrole: nil, roleRead: true, subroleRead: false)) },
            replaceSelection: { _, text in document = text; return true }, postCharacter: { document.append($0) })
        XCTAssertThrowsError(try input.type("secret", secureAllowed: true))
        XCTAssertEqual(document, "original")
    }
    @MainActor func testSlowFallbackStopsAtACharacterBoundaryAndReportsPartialText() throws {
        let field = AXUIElementCreateApplication(42)
        var now: UInt64 = 0, text = ""
        let input = ValidatedTextInput(destination: { TextDestination(element: field, security: .ordinary) },
            replaceSelection: { _, _ in false }, postCharacter: { character in text.append(character); now += 1_000_000_000 }, clock: { now })
        do { try input.type("abc", secureAllowed: false); XCTFail("Must stop slow fallback") }
        catch let error as HelperError { XCTAssertEqual(error.code, "delivery_unconfirmed"); XCTAssertEqual(error.phase, "partial") }
        catch { XCTFail("Unexpected error") }
        XCTAssertEqual(text, "a")
    }

}
