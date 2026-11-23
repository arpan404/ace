import SwiftUI

/// Personality, a section of Details, as web's: how the bot talks (its tone, humour and emoji),
/// saved as each changes and taken from its next turn, apart from its task. Humour and emoji are
/// off unless the person turns them on. The choice shows at once; a refusal puts Spade's back
/// and says why.
struct SpadeProfilePersonality: View {
    let client: ClientModel
    let agent: String
    @Binding var personality: SpadeProfileEdits.Personality
    @State private var problem: String?

    var body: some View {
        Section {
            Picker("Tone", selection: Binding(get: { personality.tone ?? "" }, set: { tone in
                save { $0.tone = tone.isEmpty ? nil : tone }
            })) {
                Text("Its own way").tag("")
                ForEach(personality.tones, id: \.value) { Text("\($0.label): \($0.says)").tag($0.value) }
            }
            .pickerStyle(.menu)
            .accessibilityIdentifier("spade.personality.tone")
            Toggle("Humour", isOn: Binding(get: { personality.humour }, set: { on in save { $0.humour = on } }))
                .accessibilityIdentifier("spade.personality.humour")
            Toggle("Emoji", isOn: Binding(get: { personality.emoji }, set: { on in save { $0.emoji = on } }))
                .accessibilityIdentifier("spade.personality.emoji")
        } header: {
            Text("Personality")
        } footer: {
            if let problem {
                Text(problem).foregroundStyle(AceTheme.StatusText.failed)
            } else {
                Text("How it talks. Only its style changes, never its task.")
            }
        }
    }

    private func save(_ change: (inout SpadeProfileEdits.Personality) -> Void) {
        let before = personality
        var next = personality
        change(&next)
        guard next != before else { return }
        personality = next
        problem = nil
        Task {
            let answer = await client.spadePersonality(agent, next)
            if answer.ok, let stored = answer.part { personality = stored }
            else {
                personality = before
                problem = answer.problem ?? "Spade didn't take the change."
            }
        }
    }
}
