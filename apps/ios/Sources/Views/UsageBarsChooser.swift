import SwiftUI

/// Which accounts the Usage glyph draws, and in what order: every account with a reading, each
/// toggleable, dragged by its handle to reorder, up to four (the glyph's room). Opens from the
/// glyph's long press and from Settings › Usage.
struct UsageBarsChooser: View {
    let client: ClientModel
    @Environment(\.dismiss) private var dismiss

    private var choices: [UsageChoice] { client.usageChoices }
    private var shown: [String] { choices.filter(\.shown).map(\.id) }
    private var full: Bool { shown.count >= UsagePins.limit }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if choices.isEmpty {
                        Text("No limits read yet")
                            .foregroundStyle(AceDesign.Ink.subtle)
                    }
                    ForEach(choices) { choice in
                        Toggle(isOn: binding(choice)) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(choice.label)
                                Text(detail(choice))
                                    .font(AceDesign.Typeface.meta)
                                    .foregroundStyle(choice.tone == .ok ? AceDesign.Ink.subtle : AceDesign.Ink.primary)
                            }
                        }
                        .disabled(!choice.shown && full)
                        .accessibilityValue(choice.spoken)
                        .accessibilityIdentifier("usage.bars.\(choice.id)")
                    }
                    .onMove(perform: move)
                } header: {
                    Text("In the top bar")
                } footer: {
                    Text(full ? "Four at most. Turn one off to add another." : "Drag to reorder. Up to four.")
                }
                if !client.usagePins.isEmpty {
                    Section {
                        Button("Show the most used") { client.setUsagePins([]) }
                            .accessibilityIdentifier("usage.bars.reset")
                    } footer: {
                        Text("Draws the accounts you used most this week.")
                    }
                }
            }
            .environment(\.editMode, .constant(.active))
            .nativeTitle("Usage bars")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.fontWeight(AceDesign.Typeface.strong)
                        .accessibilityIdentifier("usage.bars.done")
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func detail(_ choice: UsageChoice) -> String {
        let left = "\(Int(choice.left.rounded()))% left for the \(choice.span)"
        switch choice.tone {
        case .ok: return left
        case .low: return "Low, \(left)"
        case .out: return "Out for the \(choice.span)"
        }
    }

    private func binding(_ choice: UsageChoice) -> Binding<Bool> {
        Binding(
            get: { choice.shown },
            set: { on in
                let rest = shown.filter { $0 != choice.id }
                client.setUsagePins(on ? rest + [choice.id] : rest)
            }
        )
    }

    private func move(from source: IndexSet, to destination: Int) {
        var order = choices
        order.move(fromOffsets: source, toOffset: destination)
        client.setUsagePins(order.filter(\.shown).map(\.id))
    }
}
