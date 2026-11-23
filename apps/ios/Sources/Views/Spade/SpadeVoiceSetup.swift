import SwiftUI

/// At the chat's foot when a voice message couldn't go because Spade has no model that turns
/// speech into words (web's `spade-voice-setup.tsx`): one button per endpoint of the person's
/// that can, or the sentence that says how to add one; Not now closes it. The recording goes only
/// to the endpoint picked.
struct SpadeVoiceSetup: View {
    let voice: SpadeOnboarding.Voice
    /// Saves `model` as the transcription model; why it couldn't, or nil.
    let choose: (_ model: String) async -> String?
    let close: () -> Void
    @State private var choosing: String?
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.row) {
            HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                AceIcon(.microphone, size: AceDesign.Size.icon, relativeTo: .body)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .accessibilityHidden(true)
                Text(voice.choices.isEmpty ? (voice.none ?? "") :
                        "Choose how to turn speech into words. The recording goes only to the endpoint you pick.")
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.primary)
            }
            ForEach(voice.choices, id: \.self) { choice in
                Button(choosing == choice.model ? "Saving…" : choice.label) { pick(choice) }
                    .buttonStyle(RequestButtonStyle(wide: true))
                    .disabled(choosing != nil)
            }
            if let problem {
                Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed)
                    .accessibilityIdentifier("spade.voiceSetup.problem")
            }
            HStack {
                Spacer(minLength: AceTheme.Spacing.none)
                Button("Not now", action: close)
                    .buttonStyle(RequestButtonStyle())
                    .accessibilityIdentifier("spade.voiceSetup.close")
            }
        }
        .spadeSetupCard(label: "Voice messages", id: "spade.voiceSetup")
    }

    private func pick(_ choice: SpadeOnboarding.VoiceChoice) {
        choosing = choice.model
        problem = nil
        Task {
            let refused = await choose(choice.model)
            choosing = nil
            if let refused { problem = refused } else { close() }
        }
    }
}
