import SwiftUI
import UIKit

/// The person on a round disc, as the web's account disc: the ace account's picture, else their
/// initials on a quiet fill, else a person glyph until there is a name. Decorative: the button
/// it sits in names the person.
struct AccountAvatar: View {
    let name: String
    let picture: Data?
    @ScaledMetric private var size: CGFloat

    init(name: String, picture: Data?, size: CGFloat = AceDesign.Size.barAvatar) {
        self.name = name
        self.picture = picture
        _size = ScaledMetric(wrappedValue: size, relativeTo: .body)
    }

    var body: some View {
        let letters = AccountAvatar.initials(name)
        Group {
            if let picture, let image = UIImage(data: picture) {
                Image(uiImage: image).resizable().scaledToFill()
            } else if !letters.isEmpty {
                Text(letters)
                    .font(.system(size: size * Self.letterScale, weight: AceDesign.Typeface.strong))
                    .foregroundStyle(AceTheme.Colours.foreground)
            } else {
                AceIcon(.user, size: size * Self.glyphScale).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
        .frame(width: size, height: size)
        .background(AceDesign.Surface.fill, in: Circle())
        .clipShape(Circle())
        .overlay { Circle().strokeBorder(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border) }
        .accessibilityHidden(true)
    }

    /// The letters and glyph against the disc, as the web's 28px disc sets its 10px letters.
    private static let letterScale: CGFloat = 0.38
    private static let glyphScale: CGFloat = 0.5

    /// Up to two initials (`@ace/ui-core` `initials`): the first letters of the first and last
    /// words, upper-cased. "Arpan Bhandari" → "AB", "ada" → "A", blank → "".
    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: \.isWhitespace)
        guard let first = words.first?.first else { return "" }
        let last = words.count > 1 ? words.last?.first : nil
        return (String(first) + (last.map(String.init) ?? "")).uppercased()
    }
}

/// The avatar at the leading edge of the Threads and Chats header and its menu, as the web's
/// account menu: the person first (name, and their ace account's email), opening Profile; then
/// Archived threads and Settings. Signing in and out is on Profile, as on the web.
struct AccountMenuButton: View {
    let open: (SettingsRoute) -> Void
    let settings: () -> Void
    @Environment(AceAccountModel.self) private var model: AceAccountModel?

    var body: some View {
        let identity = model?.account
        let name = identity?.name ?? ""
        let shown = name.trimmingCharacters(in: .whitespaces).isEmpty ? "You" : name
        Menu {
            Section {
                Button { open(.account) } label: {
                    Text(shown)
                    Text(identity?.email ?? (model?.configured == true ? "Not signed in" : "Your profile"))
                }
                .accessibilityIdentifier("account.menu.profile")
            }
            Button("Archived threads", ace: .archive) { open(.archive) }
                .accessibilityIdentifier("account.menu.archived")
            Button("Settings", ace: .gearSix, action: settings)
                .accessibilityIdentifier("account.menu.settings")
        } label: {
            AccountAvatar(name: name, picture: model?.picture)
        }
        .accessibilityLabel("\(shown), account")
        .accessibilityIdentifier("inbox.account")
    }
}

/// The avatar's place in a home list's bar: its own round item at the bar's leading edge, with
/// the scope and compose capsule alone on the right, drawn bare on iOS 26 so the picture fills
/// its circle, as the system's own apps do.
struct AccountToolbarItem: ToolbarContent {
    let open: (SettingsRoute) -> Void
    let settings: () -> Void
    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .topBarLeading) { AccountMenuButton(open: open, settings: settings) }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { AccountMenuButton(open: open, settings: settings) }
        }
    }
}
