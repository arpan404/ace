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
    static let icons: [(id: String, label: String, symbol: String)] = [
        ("briefcase", "Briefcase", "briefcase.fill"), ("house", "House", "house.fill"),
        ("flask", "Flask", "flask.fill"), ("rocket", "Rocket", "paperplane.fill"),
        ("moon", "Moon", "moon.fill"), ("wrench", "Wrench", "wrench.adjustable.fill"),
        ("code", "Code", "chevron.left.forwardslash.chevron.right"), ("star", "Star", "star.fill"),
        ("heart", "Heart", "heart.fill"), ("lightning", "Lightning", "bolt.fill"),
    ]
    static func symbol(_ icon: String) -> String? { icons.first { $0.id == icon }?.symbol }
    /// The web's project tints for each colour, light then dark (`--project-N`).
    static func fill(_ colour: String) -> Color {
        switch colour {
        case "blue": tint(0x085076, 0x9ED5FD)
        case "green": tint(0x065A27, 0x93E4A4)
        case "amber": tint(0x5E4608, 0xF2C86C)
        case "rose": tint(0x801D4E, 0xFEB6D1)
        case "violet": tint(0x52348D, 0xD1C4FD)
        default: AceTheme.Colours.foreground
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
    var size: CGFloat = 26
    var body: some View {
        ZStack {
            Circle().fill(AccountBadgeStyle.fill(look.color))
            if let icon = look.icon, let symbol = AccountBadgeStyle.symbol(icon) {
                Image(systemName: symbol).font(.system(size: size * 0.46, weight: .bold))
                    .contentTransition(.symbolEffect(.replace))
            } else {
                Text(look.text).font(.system(size: size * (look.text.count > 1 ? 0.4 : 0.48), weight: .semibold, design: .rounded))
                    .minimumScaleFactor(0.6).lineLimit(1)
                    .contentTransition(.numericText())
            }
        }
        .foregroundStyle(AceTheme.Colours.background)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
