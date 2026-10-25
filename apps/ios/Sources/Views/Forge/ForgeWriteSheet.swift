import SwiftUI

/// A sheet to write one text for GitHub: a reply, an edit, a quote reply or a line comment. Its
/// one primary action sends it (with an optional second, "Start a review"); Suggest changes puts
/// the line's text in a suggestion block. The text stays while a send is refused or unconfirmed,
/// with the bridge's words under it; it closes only once GitHub took it.
struct ForgeWriteSheet: View {
    @State var compose: ForgeCompose
    let desk: ForgeReviewDesk
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
                ForgeEditor(text: $compose.text, placeholder: compose.placeholder, minLines: 5, completer: desk.completer)
                    .focused($focused)
                    .disabled(compose.off != nil)
                if let suggestion = compose.suggestion, compose.off == nil {
                    Button("Suggest changes", ace: .plusMinus) {
                        let block = "```suggestion\n\(suggestion)\n```\n"
                        compose.text = compose.text.isEmpty ? block : compose.text + "\n" + block
                    }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .accessibilityIdentifier("forge.write.suggest")
                }
                if let off = compose.off { Text(off).meta() }
                if let message = desk.message { Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTone.failed.text) }
                Spacer(minLength: AceTheme.Spacing.none)
                buttons
            }
            .padding(AceTheme.Spacing.lg)
            .background(AceTheme.Colours.background)
            .navigationTitle(compose.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .onAppear { desk.clearMessage(); focused = true }
        .presentationDetents([.medium, .large])
    }

    private var empty: Bool { compose.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    @ViewBuilder private var buttons: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if let secondary = compose.secondary {
                Button { send(secondary) } label: { Text(secondary.label).frame(maxWidth: .infinity, minHeight: 44) }
                    .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(AceTheme.Colours.foreground)
                    .disabled(empty || compose.off != nil || !desk.ready)
                    .accessibilityIdentifier("forge.write.secondary")
            }
            Button { send(compose.primary) } label: {
                HStack {
                    if desk.writing { ProgressView().controlSize(.small) }
                    Text(compose.primary.label).fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
            .tint(AceTheme.Colours.foreground).foregroundStyle(AceTheme.Colours.background)
            .disabled(empty || compose.off != nil || !desk.ready)
            .accessibilityIdentifier("forge.write.primary")
        }
    }

    private func send(_ choice: ForgeCompose.Choice) {
        let text = compose.text
        Task {
            if await choice.send(text) { dismiss() }
        }
    }
}
