import SwiftUI

/// A bridge answer from the Settings management screens (`bridge/settings-manage.ts`): `ok`, or
/// a problem already worded for the person.
protocol ManageAnswer: Decodable {
    var ok: Bool { get }
    var problem: String? { get }
}

extension ClientModel {
    /// A Settings management request; a refusal throws its words.
    func manage<T: ManageAnswer>(_ payload: [String: Any], as type: T.Type, timeout: Duration = .seconds(30)) async throws -> T {
        let reply = try await service(payload, as: type, timeout: timeout)
        guard reply.ok else { throw ServiceFailure(message: reply.problem ?? "That didn't work. Try again.") }
        return reply
    }
}

/// An account badge as the bridge previews it (`accountBadgePreview`).
struct AccountBadgeLook: Decodable, Equatable {
    let text: String
    let icon: String?
    let color: String
}

/// The curated badge colours and icons, in the order the web's picker offers them.
@MainActor enum AccountBadgeStyle {
    static let colours = ["neutral", "blue", "green", "amber", "rose", "violet"]
    static let icons: [(id: String, label: String, icon: AceIcon.Name)] = [
        ("briefcase", "Briefcase", .briefcase), ("house", "House", .house),
        ("flask", "Flask", .flask), ("rocket", "Rocket", .rocket),
        ("moon", "Moon", .moon), ("wrench", "Wrench", .wrench),
        ("code", "Code", .code), ("star", "Star", .star),
        ("heart", "Heart", .heart), ("lightning", "Lightning", .lightning),
    ]
    static func icon(_ id: String) -> AceIcon.Name? { icons.first { $0.id == id }?.icon }
    /// The web's project tints for each colour, light then dark (`--project-N`).
    static func fill(_ colour: String) -> Color {
        switch colour {
        case "blue": tint(0x085076, 0x9ED5FD)
        case "green": tint(0x065A27, 0x93E4A4)
        case "amber": tint(0x5E4608, 0xF2C86C)
        case "rose": tint(0x801D4E, 0xFEB6D1)
        case "violet": tint(0x52348D, 0xD1C4FD)
        default: AceDesign.Ink.primary
        }
    }
    static func name(_ colour: String) -> String { colour == "neutral" ? "Ink" : colour.capitalized }
    /// UIKit resolves dynamic colours on render threads too, so this touches nothing isolated.
    nonisolated private static func tint(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(uiColor: UIColor { @Sendable traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((value >> 16) & 255) / 255, green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
        })
    }
}

/// An account's mark: its letters or icon on its colour, the surface's colour cut out of it.
struct AccountBadgeMark: View {
    let look: AccountBadgeLook
    var size: CGFloat = AceDesign.Size.avatar
    /// The glyph and letters as a share of the badge: its own drawing, so they scale with it.
    private static let glyphScale: CGFloat = 0.46
    private static let oneLetterScale: CGFloat = 0.48
    private static let twoLetterScale: CGFloat = 0.4
    var body: some View {
        ZStack {
            Circle().fill(AccountBadgeStyle.fill(look.color))
            if let id = look.icon, let icon = AccountBadgeStyle.icon(id) {
                // Sized by the badge, which is already sized for the text around it.
                Image(ace: icon).resizable().scaledToFit()
                    .frame(width: size * Self.glyphScale, height: size * Self.glyphScale)
            } else {
                Text(look.text).font(.system(size: size * (look.text.count > 1 ? Self.twoLetterScale : Self.oneLetterScale), weight: AceDesign.Typeface.strong, design: .rounded))
                    .minimumScaleFactor(0.6).lineLimit(1)
                    .contentTransition(.numericText())
            }
        }
        .foregroundStyle(AceDesign.Surface.background)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
