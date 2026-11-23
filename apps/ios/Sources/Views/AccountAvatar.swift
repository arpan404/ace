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
/// account menu: the person first (their picture and name), opening Profile; then
/// Archived threads and Settings. Signing in and out is on Profile, as on the web.
struct AccountMenuButton: View {
    let open: (SettingsRoute) -> Void
    let settings: () -> Void
    @Environment(AceAccountModel.self) private var model: AceAccountModel?
    @Environment(SpacesModel.self) private var spaces: SpacesModel?
    @Environment(\.colorScheme) private var scheme
    @Environment(\.displayScale) private var scale

    var body: some View {
        let identity = model?.account
        let name = identity?.name ?? ""
        let shown = name.trimmingCharacters(in: .whitespaces).isEmpty ? "You" : name
        Menu {
            Button { open(.account) } label: {
                Label {
                    Text(shown)
                } icon: {
                    profileImage(name: name)
                }
                // No subtitle: a menu this narrow wraps any email across lines and ignores
                // truncation. The email shows on Profile, which this row opens.
                if identity == nil { Text(model?.configured == true ? "Not signed in" : "Your profile") }
            }
            .accessibilityIdentifier("account.menu.profile")
            // The space switcher, as the web's account menu holds it (ADR 0206 §1.4).
            if let spaces, let listed = spaces.spaces, !listed.isEmpty {
                Picker("Space", selection: Binding(get: { spaces.shown?.id ?? spaces.chosen }, set: { spaces.choose($0) })) {
                    Text("Personal").tag(Spaces.personal)
                    ForEach(listed) { org in Text(org.name).tag(org.id) }
                }
                .accessibilityIdentifier("account.menu.spaces")
            }
            Button("Archived threads", ace: .archive) { open(.archive) }
                .accessibilityIdentifier("account.menu.archived")
            Button("Settings", ace: .gearSix, action: settings)
                .accessibilityIdentifier("account.menu.settings")
        } label: {
            AccountAvatar(name: name, picture: model?.picture)
        }
        .menuOrder(.fixed)
        .barGlyph()
        .accessibilityShowsLargeContentViewer {
            AccountAvatar(name: name, picture: model?.picture)
            Text(shown)
        }
        .accessibilityLabel("\(shown), account")
        .accessibilityIdentifier("inbox.account")
    }

    private func profileImage(name: String) -> Image {
        let avatar = AccountAvatar(name: name, picture: model?.picture, size: AceDesign.Size.barIcon)
            .environment(\.colorScheme, scheme)
        let renderer = ImageRenderer(content: avatar)
        renderer.scale = scale
        if let image = renderer.uiImage {
            return Image(uiImage: image).renderingMode(.original)
        }
        return Image(ace: .user)
    }
}

/// The avatar's place in a home list's bar: a bar button at the bar's leading edge, the size of
/// the round button Back draws beside it. The photo is the button, so iOS 26 draws no glass
/// around it: the picture fills the circle with no inset.
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
