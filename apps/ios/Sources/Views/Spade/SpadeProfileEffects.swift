import SwiftUI

/// A packaged bot's declared effects in its Security section (ADR 0200 §3.4), as the install
/// review showed them: each in plain words with its reason and a switch. Turning one on is the
/// person's grant (its hosts join the bot's allow list), so it asks first, saying what it lets
/// the bot do; off narrows it at once. Only what the package declared is here, so nothing
/// undeclared can be turned on, and a send, a payment or an access change still asks each time.
struct SpadeProfileEffects: View {
    let scope: SpadeProfileScope
    let effects: [SpadePackageLine.Effect]
    /// A switch went: the package is read again.
    let changed: () async -> Void
    @State private var saving: String?
    @State private var granting: SpadePackageLine.Effect?
    @State private var problem: String?

    var body: some View {
        Section {
            ForEach(effects) { effect in
                Toggle(isOn: binding(effect)) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        Text(effect.words).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                        Text(effect.eachTime ? "\(effect.why) You decide each time." : effect.why)
                            .aceFont(AceDesign.TextRole.meta)
                            .foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                .disabled(saving != nil)
                .accessibilityIdentifier("spade.effect.\(effect.key)")
            }
        } header: {
            Text("Security")
        } footer: {
            if let problem {
                Text(problem).foregroundStyle(AceTheme.StatusText.failed)
            } else {
                Text("What \(scope.name)'s package says it does. Off, it can't.")
            }
        }
        .confirmationDialog(granting.map { "Let \(scope.name) do this?" } ?? "", isPresented: grantingShown,
                            titleVisibility: .visible, presenting: granting) { effect in
            Button("Turn on") { turn(effect, on: true) }
        } message: { effect in
            Text("\(effect.words). \(effect.why)")
        }
    }

    private func binding(_ effect: SpadePackageLine.Effect) -> Binding<Bool> {
        Binding(
            get: { effect.on },
            set: { on in
                // On is a grant: the person reads what it allows first.
                if on { granting = effect } else { turn(effect, on: false) }
            })
    }

    private var grantingShown: Binding<Bool> {
        Binding(get: { granting != nil }, set: { if !$0 { granting = nil } })
    }

    private func turn(_ effect: SpadePackageLine.Effect, on: Bool) {
        guard saving == nil else { return }
        saving = effect.key
        problem = nil
        Task {
            let outcome = await scope.client.spadePackageEffect(scope.agent, key: effect.key, on: on)
            if !outcome.ok { problem = outcome.problem }
            await changed()
            saving = nil
        }
    }
}
