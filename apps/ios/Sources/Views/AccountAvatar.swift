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

/// Opens Account from the avatar in the home toolbar.
struct AccountMenuButton: View {
    let open: () -> Void
    @Environment(AceAccountModel.self) private var model: AceAccountModel?

    var body: some View {
        let name = model?.account?.name ?? ""
        let shown = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "You" : name
        Button(action: open) {
            AccountAvatar(name: name, picture: model?.picture)
        }
        .barGlyph()
        .accessibilityShowsLargeContentViewer {
            AccountAvatar(name: name, picture: model?.picture)
            Text(shown)
        }
        .accessibilityLabel("\(shown), account")
        .accessibilityIdentifier("inbox.account")
    }
}

/// The avatar's place in a home list's bar: a bar button at the bar's leading edge, the size of
/// the round button Back draws beside it. The photo is the button, so iOS 26 draws no glass
/// around it: the picture fills the circle with no inset.
struct AccountToolbarItem: ToolbarContent {
    let open: () -> Void
    var body: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .topBarLeading) { AccountMenuButton(open: open) }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { AccountMenuButton(open: open) }
        }
    }
}
