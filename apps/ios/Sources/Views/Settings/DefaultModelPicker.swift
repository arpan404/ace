import SwiftUI

/// All default-model choices, including providers with more choices than a menu can hold.
struct DefaultModelPicker: View {
    let choices: [ProviderModelsData.Choice]
    let resettable: Bool
    let choose: (String) -> Void
    let reset: () -> Void
    @State private var query = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section {
                ForEach(matches, id: \.key) { choice in
                    Button {
                        choose(choice.key)
                        dismiss()
                    } label: {
                        HStack {
                            Text(choice.label).foregroundStyle(AceDesign.Ink.primary)
                            Spacer(minLength: AceDesign.Space.related)
                            if choice.current {
                                Image(systemName: "checkmark").foregroundStyle(AceDesign.Ink.primary)
                            }
                        }.frame(minHeight: AceDesign.Size.tap)
                    }
                    .accessibilityAddTraits(choice.current ? .isSelected : [])
                }
                if matches.isEmpty {
                    EmptyState.search(query)
                }
            }.insetRowBackground()
            if resettable {
                Section {
                    Button("Reset to the provider's default") { reset(); dismiss() }.buttonStyle(.textAction())
                }.insetRowBackground()
            }
        }
        .insetGroupedList()
        .searchable(text: $query, prompt: "Search models")
        .navigationTitle("Default model").navigationBarTitleDisplayMode(.inline)
    }

    private var matches: [ProviderModelsData.Choice] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace)
        return choices.filter { choice in
            let text = "\(choice.label) \(choice.id)".lowercased()
            return words.allSatisfy { text.contains($0) }
        }
    }
}
