import SwiftUI

/// Where the picker's list stands.
enum ModelPickerState: Equatable {
    case loading
    case ready
    /// The machine didn't answer; `title` and `message` say so and Try again asks once more.
    case failed(title: String, message: String)
}

/// The model sheet shared by a thread's composer and New thread: X on the left, a check on the
/// right, a row of providers under the title when there is more than one to choose from, then the
/// shown provider's models as plain rows under hairlines and the options for the chosen model
/// below them. A provider that can't start a thread shows one line saying why instead of models.
struct ModelPicker<Options: View>: View {
    @Binding var query: String
    var providers: [ModelPickerProvider] = []
    @Binding var shown: String
    let state: ModelPickerState
    let groups: [ModelPickerGroup]
    /// Models waiting behind "More models"; `toggleMore` opens and closes them.
    var hidden = 0
    var expanded = false
    var toggleMore: () -> Void = {}
    /// Accessibility identifiers: "<prefix>.<label>" for a model, "<prefix>.more" for More models.
    let rowPrefix: String
    var morePrefix = ""
    var retry: () -> Void = {}
    var confirming = false
    /// Puts back what the sheet changed as it went, when X closes it.
    var cancel: () -> Void = {}
    let confirm: () -> Void
    let choose: (ModelPickerRow) -> Void
    @ViewBuilder var options: () -> Options
    @Environment(\.dismiss) private var dismiss

    private var provider: ModelPickerProvider? { providers.first { $0.id == shown } }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            List {
                content
                if !searching { options() }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .environment(\.defaultMinListRowHeight, InsetStyle.rowHeight)
            .searchBarEdge()
            .searchable(text: $query, prompt: "Find a model")
            .navigationTitle("Model").navigationBarTitleDisplayMode(.inline)
            .inboxTopBar { if providers.count > 1 { ProviderStrip(providers: providers, shown: $shown) } }
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
            if let note = provider?.note {
                PickerNote(text: note).accessibilityIdentifier("agent.\(shown).reason")
            } else if groups.isEmpty {
                if searching { ContentUnavailableView.search(text: query).listRowSeparator(.hidden) }
                else { PickerNote(text: "No models listed. Check this account on your computer.") }
            } else {
                ForEach(groups) { group in
                    Section {
                        ForEach(group.rows) { row in
                            ModelChoiceRow(label: row.label, detail: row.detail, chosen: row.chosen) { choose(row) }
                                .accessibilityIdentifier("\(rowPrefix).\(row.label)")
                        }
                    } header: {
                        if let title = group.title { PickerHeading(title: title, value: group.value) }
                    }
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

/// The providers in words with their marks; the shown one sits on the quiet fill.
private struct ProviderStrip: View {
    let providers: [ModelPickerProvider]
    @Binding var shown: String

    var body: some View {
        ScrollViewReader { scroller in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: AceTheme.Spacing.xs) {
                    ForEach(providers) { provider in chip(provider).id(provider.id) }
                }
                .padding(.horizontal, AceTheme.Spacing.md)
                .padding(.vertical, AceTheme.Spacing.xs)
            }
            .onAppear { scroller.scrollTo(shown, anchor: .center) }
            .onChange(of: shown) { _, id in withAnimation(.easeOut(duration: 0.2)) { scroller.scrollTo(id, anchor: .center) } }
        }
    }

    private func chip(_ provider: ModelPickerProvider) -> some View {
        let on = provider.id == shown
        return Button { shown = provider.id } label: {
            HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                ProviderMark(provider: provider.id, size: 16, quiet: provider.note != nil)
                Text(provider.name).lineLimit(1)
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .foregroundStyle(on ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.md)
            .frame(minHeight: 36)
            .background(on ? AceTheme.Colours.fill : Color.clear, in: AceShape.capsule)
            .contentShape(AceShape.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("provider.\(provider.id)")
        .sensoryFeedback(.selection, trigger: on)
    }
}

/// An account's name over its models, with its usage on the right.
private struct PickerHeading: View {
    let title: String
    let value: String?
    var body: some View {
        HStack {
            InsetHeader(title)
            Spacer()
            if let value { Text(value).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// One plain muted line in place of a list.
private struct PickerNote: View {
    let text: String
    var body: some View {
        Text(text).aceFont(InsetStyle.label, relativeTo: .body)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .listRowBackground(Color.clear).listRowSeparator(.hidden)
    }
}
