import SwiftUI

/// Where the picker's list stands.
enum ModelPickerState: Equatable {
    case loading
    case ready
    /// The machine didn't answer; `title` and `message` say so and Try again asks once more.
    case failed(title: String, message: String)
}

/// The model sheet shared by a thread's composer and New thread, models only: X on the left, a
/// check on the right, "Find a model" under the title, Favorites and one tab per account on a
/// glass bar, then the shown tab's models as plain rows under hairlines, each with a star. A tab
/// that can't take work says why in one line above its models.
struct ModelPicker: View {
    @Binding var query: String
    let tabs: [ModelPickerTab]
    @Binding var shown: String
    let state: ModelPickerState
    let rows: [ModelPickerRow]
    /// Models waiting behind "More models"; `toggleMore` opens and closes them.
    var hidden = 0
    var expanded = false
    var toggleMore: () -> Void = {}
    /// Accessibility identifiers: "<prefix>.<label>" for a model, "<prefix>.more" for More models.
    let rowPrefix: String
    var morePrefix = ""
    /// Why the last star didn't save.
    var starProblem: String? = nil
    var retry: () -> Void = {}
    var confirming = false
    /// Puts back what the sheet changed as it went, when X closes it.
    var cancel: () -> Void = {}
    let confirm: () -> Void
    let choose: (ModelPickerRow) -> Void
    let star: (ModelPickerRow) -> Void
    @Environment(\.dismiss) private var dismiss

    private var tab: ModelPickerTab? { tabs.first { $0.id == shown } }
    private var searching: Bool { ModelSearch.active(query) }

    var body: some View {
        NavigationStack {
            List { content }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .environment(\.defaultMinListRowHeight, InsetStyle.rowHeight)
            // Under the title on every iOS, above the tabs, so it never moves to the bottom.
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find a model")
            .navigationTitle("Model").navigationBarTitleDisplayMode(.inline)
            .inboxTopBar { if tabs.count > 1 && !searching { tabBar } }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { cancel(); dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("modelSheet.close")
                }
                ToolbarItem(placement: .confirmationAction) { confirmButton }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .toggleStyle(.systemSwitch)
        .presentationDetents([.large]).presentationDragIndicator(.visible)
    }

    private var tabBar: some View {
        GlassChoice(items: tabs.map(item), selection: shown, idPrefix: "tab") { shown = $0 }
            .padding(.horizontal, AceTheme.Spacing.lg)
            .padding(.top, AceTheme.Spacing.xs)
            .padding(.bottom, AceTheme.Spacing.sm)
    }
    private func item(_ tab: ModelPickerTab) -> GlassChoiceItem {
        GlassChoiceItem(id: tab.id, label: tab.name,
                        glyph: tab.provider.map { .provider($0, quiet: tab.note != nil) } ?? .symbol("star"))
    }

    @ViewBuilder private var content: some View {
        switch state {
        case .loading:
            HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear).listRowSeparator(.hidden)
        case .failed(let title, let message):
            ContentUnavailableView {
                Label(title, systemImage: "wifi.exclamationmark")
            } description: { Text(message) } actions: { Button("Try again", action: retry) }
            .listRowSeparator(.hidden)
        case .ready:
            if let starProblem { PickerNote(text: starProblem).accessibilityIdentifier("modelSheet.starProblem") }
            if !searching, let note = tab?.note {
                PickerNote(text: note).accessibilityIdentifier("tab.\(shown).reason")
            }
            if rows.isEmpty {
                if searching { ContentUnavailableView.search(text: query).listRowSeparator(.hidden) }
                else if shown == ModelPickerTab.favorites {
                    PickerNote(text: "Star a model to keep it here.").accessibilityIdentifier("favorites.empty")
                } else if tab?.note == nil { PickerNote(text: "No models on this account.") }
            } else {
                Section {
                    ForEach(rows) { row in
                        ModelChoiceRow(row: row, identifier: "\(rowPrefix).\(row.label)", enabled: searching || tab?.note == nil,
                                       choose: { choose(row) }, star: { star(row) })
                    }
                    if hidden > 0 || expanded { moreRow }
                }
                .listSectionSeparator(.hidden, edges: .top)
            }
        }
    }

    private var moreRow: some View {
        Button(action: toggleMore) {
            HStack {
                Text(expanded ? "Fewer models" : "More models").aceFont(InsetStyle.label, relativeTo: .body)
                Spacer()
                if !expanded { InsetValue(text: "\(hidden)") }
            }
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .accessibilityValue(expanded ? "" : "\(hidden) more")
        .accessibilityIdentifier("\(morePrefix).\(expanded ? "fewer" : "more")")
    }

    @ViewBuilder private var confirmButton: some View {
        if confirming { ProgressView() }
        else if #available(iOS 26, *) {
            Button(role: .confirm, action: confirm) { Image(systemName: "checkmark").foregroundStyle(AceTheme.Colours.onAccent) }
                .buttonStyle(.glassProminent).tint(AceTheme.Colours.accent)
                .accessibilityLabel("Done").accessibilityIdentifier("modelSheet.done")
        } else {
            Button(action: confirm) { Image(systemName: "checkmark").fontWeight(.semibold) }
                .accessibilityLabel("Done").accessibilityIdentifier("modelSheet.done")
        }
    }
}

/// One plain muted line in place of, or above, a list.
private struct PickerNote: View {
    let text: String
    var body: some View {
        Text(text).aceFont(InsetStyle.label, relativeTo: .body)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .listRowBackground(Color.clear).listRowSeparator(.hidden)
    }
}
