import Testing
import UIKit
@testable import Ace

/// Every text role is drawn at its system text style's own size, at the default text size and as
/// Dynamic Type grows or shrinks it, so ace's text sits on iOS's scale everywhere.
@Suite @MainActor struct TypeRoleTests {
    nonisolated static let roles: [(String, AceDesign.Role)] = [
        ("header", AceDesign.TextRole.header), ("navTitle", AceDesign.TextRole.navTitle),
        ("navSubtitle", AceDesign.TextRole.navSubtitle), ("message", AceDesign.TextRole.message),
        ("answer", AceDesign.TextRole.answer), ("rowTitle", AceDesign.TextRole.rowTitle),
        ("segment", AceDesign.TextRole.segment), ("action", AceDesign.TextRole.action),
        ("step", AceDesign.TextRole.step), ("meta", AceDesign.TextRole.meta),
        ("time", AceDesign.TextRole.time), ("code", AceDesign.TextRole.code),
        ("branch", AceDesign.TextRole.branch), ("caption", AceDesign.TextRole.caption),
    ]
    nonisolated static let sizes: [UIContentSizeCategory] = [.extraSmall, .large, .extraExtraExtraLarge, .accessibilityExtraExtraExtraLarge]

    @Test(arguments: sizes) func everyRoleIsItsSystemStylesSize(_ category: UIContentSizeCategory) {
        let traits = UITraitCollection(preferredContentSizeCategory: category)
        for (name, role) in Self.roles {
            let system = UIFont.preferredFont(forTextStyle: role.uiTextStyle, compatibleWith: traits).pointSize
            let drawn = role.uiFont(traits: traits).pointSize
            #expect(abs(drawn - system) < 0.5, "\(name) at \(category.rawValue): \(drawn) against \(system)")
        }
    }

    /// iOS's published Dynamic Type sizes, which a role scaled from its default size misses: a
    /// footnote role scaled by `UIFontMetrics` reaches 17 at XXXL where the system draws 19.
    @Test func rolesFollowTheSystemsTableNotAScaleFromTheirDefaultSize() {
        let table: [(AceDesign.Role, UIContentSizeCategory, CGFloat)] = [
            (AceDesign.TextRole.rowTitle, .extraSmall, 14), (AceDesign.TextRole.rowTitle, .large, 17),
            (AceDesign.TextRole.rowTitle, .extraExtraExtraLarge, 23), (AceDesign.TextRole.header, .extraExtraExtraLarge, 23),
            (AceDesign.TextRole.segment, .extraExtraExtraLarge, 21), (AceDesign.TextRole.meta, .extraExtraExtraLarge, 19),
            (AceDesign.TextRole.time, .extraExtraExtraLarge, 18), (AceDesign.TextRole.branch, .extraExtraExtraLarge, 17),
            (AceDesign.TextRole.time, .extraSmall, 11),
        ]
        for (role, category, expected) in table {
            #expect(role.pointSize(at: category) == expected, "\(role.uiTextStyle.rawValue) at \(category.rawValue)")
        }
    }

    @Test func aRolesLinesGrowInStepWithItsSize() {
        let role = AceDesign.TextRole.meta
        #expect(role.lineHeight(at: .large) == role.lineHeight)
        #expect(role.lineHeight(at: .extraExtraExtraLarge) > role.lineHeight(at: .large))
        #expect(abs(role.lineHeight(at: .extraExtraExtraLarge) / role.pointSize(at: .extraExtraExtraLarge) - role.lineHeight / role.size) < 0.001)
    }

    @Test func theComposerTypesAtTheRowTitlesSize() {
        let traits = UITraitCollection(preferredContentSizeCategory: .large)
        let font = AceDesign.inputAttributes(traits: traits)[.font] as? UIFont
        #expect(font?.pointSize == UIFont.preferredFont(forTextStyle: .body, compatibleWith: traits).pointSize)
    }
}
