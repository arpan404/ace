import SwiftUI
import UIKit

/// One listing as a row of the store (spec item 27): its picture, title, one line, type and
/// publisher, and its one button at the trailing edge. The words open its page; the button acts
/// without opening it. A long press offers Share link, Open publisher and, when installed,
/// Remove. At accessibility sizes the button goes under the words.
struct MarketRow: View {
    let listing: MarketListing
    /// "1" for a trending row; nil elsewhere.
    var rank: Int? = nil
    /// A trending row's movement ("Up 3"), said after its line.
    var note: String? = nil
    @Environment(\.marketRows) private var rows
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        StackingRow {
            Button { rows.open(.entry(listing.key)) } label: {
                HStack(spacing: AceDesign.Space.row) {
                    if let rank {
                        Text("\(rank)").aceFont(AceDesign.TextRole.rowTitle).fontWeight(AceDesign.Typeface.strong)
                            .foregroundStyle(AceDesign.Ink.muted).monospacedDigit()
                            .frame(minWidth: AceDesign.Size.icon)
                    }
                    if !typeSize.isAccessibilitySize { MarketListingIcon(listing: listing) }
                    words
                    Spacer(minLength: AceDesign.Space.related)
                }
                .frame(minHeight: AceDesign.Size.tap)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spoken)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("market.row.\(listing.id)")
            MarketRowAction(listing: listing)
        }
        .padding(.vertical, AceDesign.Space.tight)
        .contextMenu { menu }
    }

    private var words: some View {
        VStack(alignment: .leading, spacing: AceDesign.Size.rowLineGap) {
            Text(listing.title).aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceDesign.Ink.primary).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            Text(listing.line).aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(AceDesign.Ink.muted).lineLimit(typeSize.isAccessibilitySize ? nil : 2)
            Text(meta).aceFont(AceDesign.TextRole.caption)
                .foregroundStyle(AceDesign.Ink.subtle).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// "Skill · Mira", "Suit · By ace · Up 3".
    private var meta: String {
        var parts = [listing.typeWord]
        if listing.byAce { parts.append("By ace") } else if let publisher = listing.publisher { parts.append(publisher) }
        if let note { parts.append(note) }
        return parts.joined(separator: " · ")
    }

    /// VoiceOver reads the listing and its rank when present. The action is a separate element.
    private var spoken: String {
        [rank.map { "Rank \($0)" }, listing.title, listing.typeWord,
         listing.byAce ? "By ace" : listing.publisher, listing.line, note]
            .compactMap { $0 }.joined(separator: ", ")
    }

    @ViewBuilder private var menu: some View {
        if let link = listing.link, let url = URL(string: link) {
            ShareLink(item: url) { Label("Share link", ace: .export) }
        }
        if let handle = listing.publisher, !listing.byAce {
            Button { rows.open(.browse(.publisher(handle: handle))) } label: { Label("Open publisher", ace: .user) }
        }
        let copies = listing.action?.copies ?? []
        if copies.count == 1, let copy = copies.first {
            Button(role: .destructive) { rows.remove(copy) } label: { Label("Remove", ace: .trash) }
                .disabled(rows.offline)
        } else if copies.count > 1 {
            // One listing made into several bots: the person picks which bot loses it.
            Menu {
                ForEach(copies) { copy in
                    Button(copy.label, role: .destructive) { rows.remove(copy) }
                }
            } label: { Label("Remove from…", ace: .trash) }
                .disabled(rows.offline)
        }
    }
}

/// A row's one button, as the bridge decided it: Get, Update, the word Installed, why it can't
/// be installed, or nothing while what's installed is unknown. Update with several bots to update
/// asks which. While the machine is offline Get and Update are disabled and say so.
struct MarketRowAction: View {
    let listing: MarketListing
    @Environment(\.marketRows) private var rows

    var body: some View {
        if let action = listing.action {
            switch action.kind {
            case "get":
                Button(action.word ?? "Get") { rows.get(.install(listing.key), listing.title) }
                    .buttonStyle(.secondaryAction)
                    .disabled(rows.offline)
                    .accessibilityLabel("Get \(listing.title)")
                    .accessibilityHint(rows.offline ? "Your machine is offline." : "")
                    .accessibilityIdentifier("market.get.\(listing.id)")
            case "update":
                update(action)
                    .disabled(rows.offline)
                    .accessibilityLabel("Update \(listing.title)")
                    .accessibilityHint(rows.offline ? "Your machine is offline." : "")
                    .accessibilityIdentifier("market.update.\(listing.id)")
            case "installed":
                Text(action.word ?? "Installed").aceFont(AceDesign.TextRole.action).foregroundStyle(AceDesign.Ink.subtle)
            case "blocked":
                if let reason = action.reason {
                    Text(reason).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.subtle)
                        .multilineTextAlignment(.trailing).lineLimit(2)
                }
            default:
                EmptyView()
            }
        }
    }

    @ViewBuilder private func update(_ action: MarketListingAction) -> some View {
        let updates = action.updates
        if updates.count > 1 {
            Menu {
                ForEach(updates) { copy in
                    Button(copy.label) { rows.get(.update(copy.install.key), listing.title) }
                }
            } label: { Text(action.word ?? "Update") }
                .menuStyle(.button)
                .buttonStyle(.secondaryAction)
        } else if let copy = updates.first {
            Button(action.word ?? "Update") { rows.get(.update(copy.install.key), listing.title) }
                .buttonStyle(.secondaryAction)
        }
    }
}

/// The same artwork sources as the web Store: a listing preview, then the package's look.
struct MarketListingIcon: View {
    let listing: MarketListing
    var size: CGFloat = AceDesign.Size.tap + AceDesign.Space.row
    var height: CGFloat? = nil

    var body: some View {
        MarketPictureView(hash: listing.picture, kind: "preview", size: size, height: height) {
            MarketPackageArt(listing: listing, size: height.map { min($0 / 2, size) } ?? size)
                .id(LookKey(entry: listing.key, version: listing.version))
        }
        .accessibilityHidden(true)
    }

    private struct LookKey: Hashable {
        let entry: MarketEntryKey
        let version: String?
    }
}

private struct MarketPackageArt: View {
    let listing: MarketListing
    let size: CGFloat
    @Environment(\.marketRows) private var rows
    @Environment(\.colorScheme) private var scheme
    @State private var look: MarketLook?

    var body: some View {
        let swatches = look?.swatches(prefersDark: scheme == .dark).compactMap(Color.init(hexString:)) ?? []
        Group {
            if let face = look?.face {
                BotFaceView(face: face, size: size)
            } else if !swatches.isEmpty {
                HStack(spacing: AceTheme.Spacing.none) {
                    ForEach(swatches.indices, id: \.self) { swatches[$0] }
                }
            } else {
                AceIcon(glyph, size: size * 0.45, relativeTo: .title3)
                    .foregroundStyle(AceDesign.Ink.muted)
            }
        }
        .task(id: rows.model?.marketGeneration) {
            guard listing.type == "suit" || listing.type == "spade-bot",
                  let model = rows.model, let result = try? await model.marketLook(listing),
                  !Task.isCancelled else { return }
            look = result
        }
    }

    private var glyph: AceIcon.Name {
        switch listing.type {
        case "suit": .palette
        case "spade-bot": .robot
        case "spade-skill": .lightning
        case "spade-plugin", "ace-plugin": .plug
        default: .package
        }
    }
}

/// A market picture by its hash in a rounded tile, read once through `marketPicture` and kept
/// by hash, since a hash never changes its bytes. `placeholder` shows until it arrives.
struct MarketPictureView<Placeholder: View>: View {
    let hash: String?
    /// `preview` or `avatar`.
    let kind: String
    let size: CGFloat
    var height: CGFloat? = nil
    var round = false
    @ViewBuilder let placeholder: () -> Placeholder
    @Environment(\.marketRows) private var rows
    @Environment(\.displayScale) private var scale
    @State private var loaded: (key: String, image: UIImage)?

    private var pixels: CGFloat { (max(size, height ?? size) * scale).rounded(.up) }
    private var imageKey: String? { hash.map { "\(kind)/\($0)/\(pixels)" } }

    var body: some View {
        ZStack {
            if round { Circle().fill(AceDesign.Surface.fill) } else {
                RoundedRectangle(cornerRadius: AceDesign.Size.rowCorner, style: .continuous).fill(AceDesign.Surface.fill)
            }
            if let loaded, loaded.key == imageKey {
                Image(uiImage: loaded.image).resizable().scaledToFill()
            } else {
                placeholder()
            }
        }
        .frame(width: size, height: height ?? size)
        .clipShape(round ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: AceDesign.Size.rowCorner, style: .continuous)))
        .task(id: imageKey) { await load() }
    }

    private func load() async {
        guard let hash, let key = imageKey else { return }
        if let kept = MarketPictures.cache.object(forKey: key as NSString) {
            loaded = (key, kept)
            return
        }
        guard let model = rows.model, let picture = try? await model.marketPicture(hash, kind: kind),
              let data = Data(base64Encoded: picture.data) else { return }
        let pixels = self.pixels
        let decoded = await Task.detached(priority: .utility) {
            ImageDecoding.source(data).flatMap { ImageDecoding.preview($0, pixels: pixels) }
        }.value
        guard let decoded, !Task.isCancelled else { return }
        MarketPictures.cache.setObject(decoded, forKey: key as NSString, cost: Int(decoded.size.width * decoded.size.height * 4))
        loaded = (key, decoded)
    }
}

/// Market pictures decoded this launch, keyed by kind, hash and pixel size.
@MainActor enum MarketPictures {
    static let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 24 * 1024 * 1024
        return cache
    }()
}
