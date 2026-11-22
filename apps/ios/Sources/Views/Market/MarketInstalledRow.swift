import SwiftUI

/// Installed as `bridge/market-installed.ts` answers it: updates first, each row's words and
/// actions decided there.
struct MarketInstalledPage: Decodable, Equatable {
    let offline: Bool
    let rows: [MarketInstalledItem]
    let updates: Int
    /// "2 updates"; nil with none.
    let updatesText: String?
    /// The updates section's title: "2 updates" or "No updates".
    let updatesTitle: String
    /// "Everything is up to date…", when something is installed and nothing waits.
    let upToDate: String?
    /// What an empty Installed says.
    let empty: String?

    var waiting: [MarketInstalledItem] { rows.filter { $0.section == "updates" } }
    var rest: [MarketInstalledItem] { rows.filter { $0.section != "updates" } }
}

/// One installed entry: the shared row (`MarketInstall`) and what Installed shows and offers.
struct MarketInstalledItem: Decodable, Identifiable, Hashable {
    private enum Keys: String, CodingKey {
        case section, meta, off, notes, updateLabel, updateLine, rollBackTo, turnOnWord, turnOnQuick, turnOnAsk,
             removeQuestion, removeDetail
    }
    let install: MarketInstall
    /// `updates` or `installed`.
    let section: String
    /// "Skill · 1.0.0 → 1.1.0".
    let meta: String
    let off: Bool
    /// Lines under the title; while off, the first says why.
    let notes: [String]
    /// "Update Inbox to 1.1.0" when an update is offered.
    let updateLabel: String?
    /// For a bot made from a package: which one bot moves.
    let updateLine: String?
    let rollBackTo: String?
    /// The question before a withdrawn entry runs again: its publisher's reason and the risk.
    struct Ask: Decodable, Hashable { let question: String; let detail: String; let confirm: String }
    /// "Turn back on" or "Resume"; nil when it can't come back (on, or blocked).
    let turnOnWord: String?
    /// Only what the person turned off comes back in one step, as a swipe.
    let turnOnQuick: Bool
    /// Set for a withdrawn entry: it comes back only through this question, from the row's menu.
    let turnOnAsk: Ask?
    let removeQuestion: String
    let removeDetail: String

    var id: String { install.id }

    init(from decoder: any Decoder) throws {
        install = try MarketInstall(from: decoder)
        let values = try decoder.container(keyedBy: Keys.self)
        section = try values.decode(String.self, forKey: .section)
        meta = try values.decode(String.self, forKey: .meta)
        off = try values.decode(Bool.self, forKey: .off)
        notes = try values.decode([String].self, forKey: .notes)
        updateLabel = try values.decodeIfPresent(String.self, forKey: .updateLabel)
        updateLine = try values.decodeIfPresent(String.self, forKey: .updateLine)
        rollBackTo = try values.decodeIfPresent(String.self, forKey: .rollBackTo)
        turnOnWord = try values.decodeIfPresent(String.self, forKey: .turnOnWord)
        turnOnQuick = try values.decode(Bool.self, forKey: .turnOnQuick)
        turnOnAsk = try values.decodeIfPresent(Ask.self, forKey: .turnOnAsk)
        removeQuestion = try values.decode(String.self, forKey: .removeQuestion)
        removeDetail = try values.decode(String.self, forKey: .removeDetail)
    }
}

/// An Installed row: title, type, version and machine, why it's off, the bots approval under a
/// waiting skill, and Update at the trailing edge when one is offered. Swipes and the remove
/// question belong to the list.
struct MarketInstalledRow: View {
    let model: ClientModel
    let item: MarketInstalledItem
    let machineName: String
    /// The machine is offline or this row's change is under way: nothing can be pressed.
    let held: Bool
    let open: () -> Void
    let update: () -> Void
    let changed: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceDesign.Space.related))
            : AnyLayout(HStackLayout(alignment: .center, spacing: AceDesign.Space.related))
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            layout {
                Button(action: open) { words }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .combine)
                    .accessibilityIdentifier("market.installed.\(item.id)")
                if !typeSize.isAccessibilitySize { Spacer(minLength: AceDesign.Space.related) }
                if let label = item.updateLabel, model.canOperate {
                    Button("Update", action: update)
                        .buttonStyle(.secondaryAction)
                        .disabled(held)
                        .accessibilityLabel(label)
                        .accessibilityIdentifier("market.installed.update.\(item.id)")
                }
            }
            // Its own control, beside the row's open tap rather than inside it.
            if item.install.waitsForBots {
                MarketBotsApproval(model: model, install: item.install) { _ in changed() }
                    .disabled(held)
            }
        }
        .frame(minHeight: AceDesign.Size.tap)
    }

    private var words: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Text(item.install.title).aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(item.off ? AceDesign.Ink.muted : AceDesign.Ink.primary)
            Text("\(item.meta) · \(machineName)").aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(AceDesign.Ink.subtle).monospacedDigit()
            ForEach(Array(item.notes.enumerated()), id: \.offset) { index, note in
                Text(note).aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(item.off && index == 0 ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let line = item.updateLine {
                Text(line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}
