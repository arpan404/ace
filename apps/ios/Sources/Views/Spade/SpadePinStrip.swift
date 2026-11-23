import SwiftUI

/// The pinned bots and groups above the Spade list (docs/design/spade.md §2), as web's pin strip
/// (`spade-pin-strip.tsx`): one row of faces that scrolls sideways, oldest pin first, each with
/// its name under it and its row's dot (needs you, failed). A face opens its conversation; a long
/// press offers Unpin.
struct SpadePinStrip: View {
    let entries: [SpadeRoster.Entry]
    let route: (SpadeRoster.Entry) -> SpadeRoute
    let unpin: (SpadeRoster.Entry) -> Void

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: AceDesign.Space.row) {
                ForEach(entries) { entry in
                    NavigationLink(value: route(entry)) { SpadePinFace(bot: entry.bot) }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button { unpin(entry) } label: { Label("Unpin", ace: .pushPinSlash) }
                                .accessibilityIdentifier("spade.unpin")
                        }
                        .accessibilityIdentifier(entry.bot.group.map { "spade.pin.group.\($0)" } ?? "spade.pin.\(entry.bot.id)")
                }
            }
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.vertical, AceDesign.Space.related)
        }
        .scrollIndicators(.hidden)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pinned")
        .accessibilityIdentifier("spade.pins")
    }
}

/// One pinned face: the row's face with its dot, and the name under it on one line.
private struct SpadePinFace: View {
    let bot: SpadeModel.Bot

    var body: some View {
        VStack(spacing: AceDesign.Space.tight) {
            SpadeBotFace(bot: bot)
            Text(bot.name)
                .aceFont(AceDesign.TextRole.meta)
                .fontWeight(bot.state == "unseen" ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
                .foregroundStyle(AceDesign.Ink.primary)
                .lineLimit(1)
        }
        .frame(width: AceDesign.Size.tap + AceDesign.Space.section)
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([bot.name, bot.line].filter { !$0.isEmpty }.joined(separator: ", "))
        .accessibilityAddTraits(.isButton)
    }
}
