import SwiftUI

/// Settings › Appearance › Look: every built-in theme and every Suit the connected machines have
/// (ADR 0150) as equal cards, as the web's Look grid. A theme card turns the Suit off; a Suit card
/// turns it on, drawn in its own colours over its still. A Suit that can't show is dimmed with
/// its reason under it and can't be picked.
struct LookGrid: View {
    let inbox: MachineInbox?
    let scheme: ColorScheme
    let accent: String
    let theme: String
    let pickTheme: (String) -> Void
    @Environment(SuitLookModel.self) private var suits: SuitLookModel?
    @State private var gallery = SuitGallery()
    private let columns = [GridItem(.adaptive(minimum: AceDesign.Size.tap * 2 + AceDesign.Space.tight), spacing: AceDesign.Space.row, alignment: .top)]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .center, spacing: AceDesign.Space.margin) {
            ForEach(AceTheme.themeChoices, id: \.id) { choice in
                PickerCard(name: choice.name, selected: suits?.setting == nil && theme == choice.id, id: "appearance.theme.\(choice.id)") {
                    pickTheme(choice.id)
                } preview: { ThemePreview(theme: choice.id, accent: accent, scheme: scheme) }
            }
            ForEach(rows, id: \.row.id) { listed in suitCard(listed) }
        }
        .task(id: rows.map { $0.row.id + $0.row.contentHash }) { await gallery.load(rows) }
    }

    /// Each Suit once, from the first connected machine that lists it.
    private var rows: [SuitGallery.Listed] {
        var seen = Set<String>()
        var listed: [SuitGallery.Listed] = []
        for session in inbox?.sessions ?? [] where session.client.connection == "ready" {
            for row in session.client.suits ?? [] where seen.insert(row.id).inserted {
                listed.append(SuitGallery.Listed(row: row, client: session.client))
            }
        }
        return listed
    }

    private func suitCard(_ listed: SuitGallery.Listed) -> some View {
        let row = listed.row
        let card = gallery.cards[row.id]
        let reason = row.unavailable ?? card?.suit.unavailable
        return VStack(spacing: AceDesign.Space.tight) {
            PickerCard(name: row.name, selected: suits?.setting == row.id, id: "appearance.suit.\(row.id)") {
                LookCrossfade.run { suits?.choose(row.id) }
            } preview: {
                if let card { ThemePreview(suit: card.suit, still: card.still(scheme), scheme: scheme) }
                else { ThemePreview(theme: "ace", accent: "theme", scheme: scheme).redacted(reason: .placeholder) }
            }
            .disabled(reason != nil)
            .opacity(reason == nil ? 1 : AceDesign.Ink.recede)
            .accessibilityHint(reason ?? row.description)
            if let reason {
                Text(reason)
                    .font(AceDesign.Typeface.caption)
                    .foregroundStyle(AceDesign.Ink.subtle)
                    .lineLimit(3)
                    .multilineTextAlignment(.center)
                    .accessibilityHidden(true)
            }
        }
    }
}

/// Every listed Suit resolved for its card: its colours and its still per scheme, read once per
/// version from the machine that lists it.
@MainActor @Observable final class SuitGallery {
    struct Listed { let row: PhoneSuitRow; let client: ClientModel }
    struct Card {
        let suit: PhoneSuit
        let light: UIImage?
        let dark: UIImage?
        func still(_ scheme: ColorScheme) -> UIImage? { scheme == .dark ? dark : light }
    }
    private(set) var cards: [String: Card] = [:]

    func load(_ rows: [Listed]) async {
        for listed in rows where cards[listed.row.id]?.suit.contentHash != listed.row.contentHash {
            guard let suit = try? await listed.client.service(["type": "suit.read", "id": listed.row.id], as: PhoneSuit.self) else { continue }
            if Task.isCancelled { return }
            let image = { (path: String?) async -> UIImage? in
                guard let path else { return nil }
                let asked: [String: Any] = ["type": "suit.asset", "id": suit.id, "contentHash": suit.contentHash, "path": path]
                let file = try? await SuitAssets.fetched(suit, path) { try await listed.client.service(asked, as: SuitFollow.AssetReply.self).data }
                return file.flatMap { UIImage(contentsOfFile: $0.path) }
            }
            let light = await image(suit.stills.light)
            let dark = suit.stills.dark == suit.stills.light ? light : await image(suit.stills.dark)
            cards[suit.id] = Card(suit: suit, light: light, dark: dark)
        }
    }
}
