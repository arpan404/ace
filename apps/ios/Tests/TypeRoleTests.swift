import Testing
import UIKit
@testable import Ace

/// Every text role is drawn at its system text style's own size, at the default text size and as
/// Dynamic Type grows or shrinks it, so ace's text sits on iOS's scale everywhere.
@Suite @MainActor struct TypeRoleTests {
    static let roles: [(String, AceDesign.Role)] = [
        ("header", AceDesign.TextRole.header), ("navTitle", AceDesign.TextRole.navTitle),
        ("navSubtitle", AceDesign.TextRole.navSubtitle), ("message", AceDesign.TextRole.message),
        ("answer", AceDesign.TextRole.answer), ("rowTitle", AceDesign.TextRole.rowTitle),
        ("segment", AceDesign.TextRole.segment), ("action", AceDesign.TextRole.action),
        ("step", AceDesign.TextRole.step), ("meta", AceDesign.TextRole.meta),
        ("time", AceDesign.TextRole.time), ("code", AceDesign.TextRole.code),
        ("branch", AceDesign.TextRole.branch), ("caption", AceDesign.TextRole.caption),
    ]
    static let sizes: [UIContentSizeCategory] = [.extraSmall, .large, .extraExtraExtraLarge, .accessibilityExtraExtraExtraLarge]

    @Test(arguments: sizes) func everyRoleIsItsSystemStylesSize(_ category: UIContentSizeCategory) {
        let traits = UITraitCollection(preferredContentSizeCategory: category)
        for (name, role) in Self.roles {
            let system = UIFont.preferredFont(forTextStyle: role.uiTextStyle, compatibleWith: traits).pointSize
            let drawn = role.uiFont(traits: traits).pointSize
            #expect(abs(drawn - system) < 0.5, "\(name) at \(category.rawValue): \(drawn) against \(system)")
        }
    }

    @Test func theComposerTypesAtTheRowTitlesSize() {
        let traits = UITraitCollection(preferredContentSizeCategory: .large)
        let font = AceDesign.inputAttributes(traits: traits)[.font] as? UIFont
        #expect(font?.pointSize == UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize)
    }
}
