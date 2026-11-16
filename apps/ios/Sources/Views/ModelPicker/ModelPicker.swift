import SwiftUI

/// Where the picker's list stands.
enum ModelPickerState: Equatable {
    case loading
    case ready
    /// The machine didn't answer; `title` and `message` say so and Try again asks once more.
    case failed(title: String, message: String)
}

/// The one model sheet shared by an open thread and New thread: X on the left, a check on the
/// right, "Find a model" at the bottom within the thumb's reach (under the title before iOS 26).
/// At its top, Effort and Speed for the model it runs on (`TuneSection`); below them the account
/// whose models show (`AccountPicker`: Favorites or one account), pinned while the models scroll,
/// then that account's models as plain rows under hairlines, each with a star. An account that
/// can't take work says why in one line above its models. Searching hides the tune rows and the
/// account. A pick brings the Effort row into view and moves VoiceOver focus to it.
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
    /// Done (✓) in the bar.
    let confirm: () -> Void
    /// X beside Done, putting back what the sheet changed (`cancel`); without it Done is the only
    /// bar button and a swipe down closes the sheet as Done does.
    var closable = true
    let choose: (ModelPickerRow) -> Void
    let star: (ModelPickerRow) -> Void
    /// Effort and Speed for the model it would run on; nil or empty shows no rows.
    var tune: TuneChoices? = nil
    var pickEffort: (TuneChoiceRow.Level) -> Void = { _ in }
    var pickSpeed: (TuneChoiceRow.Level) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @State private var detent: PresentationDetent = .large
    /// Counts model picks, so the Effort row comes into view and takes VoiceOver focus after each.
    @State private var picks = 0
    @AccessibilityFocusState private var tuneFocus: Bool

    private var tab: ModelPickerTab? { tabs.first { $0.id == shown } }
    private var searching: Bool { ModelSearch.active(query) }

    var body: some View {
        NavigationStack {
            ScrollViewReader { scroller in
                List { content }
                    // A model picked: its Effort and Speed are what to set next.
                    .onChange(of: picks) {
                        guard let tune, !tune.isEmpty, !searching else { return }
                        withAnimation { scroller.scrollTo(TuneSection.anchor, anchor: .top) }
                        tuneFocus = true
                    }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .environment(\.defaultMinListRowHeight, InsetStyle.rowHeight)
            .modifier(ModelSearchField(query: $query))
            .navigationTitle("Model").navigationBarTitleDisplayMode(.large)
            .toolbar {
                if closable {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { cancel(); dismiss() } label: { Image(systemName: "xmark") }
                            .accessibilityLabel("Close").accessibilityIdentifier("modelSheet.close")
                    }
                }
                ToolbarItem(placement: .confirmationAction) { confirmButton }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .toggleStyle(.systemSwitch)
        .presentationDetents([.medium, .large], selection: $detent).presentationDragIndicator(.visible)
    }

    private var accounts: some View {
        AccountPicker(tabs: tabs, shown: $shown)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, AceTheme.Spacing.lg)
            .padding(.top, AceTheme.Spacing.xs)
            .padding(.bottom, AceTheme.Spacing.sm)
            .background(AceTheme.Colours.background)
            .listRowInsets(EdgeInsets())
    }

    @ViewBuilder private var content: some View {
        if let tune, !tune.isEmpty, !searching {
            TuneSection(choices: tune, focus: $tuneFocus, pickEffort: pickEffort, pickSpeed: pickSpeed)
        }
        // The account heads its models and stays pinned while they scroll.
        Section { models } header: { if tabs.count > 1 && !searching { accounts } }
            .listSectionSeparator(.hidden, edges: .top)
    }

    @ViewBuilder private var models: some View {
        switch state {
        case .loading:
            SkeletonRows(count: 4, label: "Loading models").listRowBackground(Color.clear).listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets())
        case .failed(let title, let message):
            QuietProblemRow(title: title, detail: message, action: "Try again",
                            identifier: "modelSheet.retry", run: retry)
        case .ready:
            if let starProblem { PickerNote(text: starProblem).accessibilityIdentifier("modelSheet.starProblem") }
            if !searching, let note = tab?.note {
                PickerNote(text: note).accessibilityIdentifier("tab.\(shown).reason")
            }
            if rows.isEmpty {
                if searching { EmptyState.search(query).listRowSeparator(.hidden) }
                else if shown == ModelPickerTab.favorites {
                    PickerNote(text: "Star a model to keep it here.").accessibilityIdentifier("favorites.empty")
                } else if tab?.note == nil { PickerNote(text: "No models on this account.") }
            } else {
                ForEach(rows) { row in
                    ModelChoiceRow(row: row, identifier: "\(rowPrefix).\(row.label)", enabled: (searching || tab?.note == nil) && row.note == nil,
                                   choose: { choose(row); picks += 1 }, star: { star(row) })
                }
                if hidden > 0 || expanded { moreRow }
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

/// "Find a model" in the sheet's bottom bar on iOS 26 and later, where a thumb reaches it; iOS 18
/// has no bottom search, so there it stays under the title.
private struct ModelSearchField: ViewModifier {
    @Binding var query: String
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.searchable(text: $query, placement: .toolbar, prompt: "Find a model")
        } else {
            content.searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find a model")
        }
    }
}
