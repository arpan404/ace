import SwiftUI

/// A packaged bot's declared effects in its Security section (ADR 0200 §3.4), as the install
/// review showed them: each in plain words with its reason and a switch. Turning one on is the
/// person's grant (its hosts join the bot's allow list), so it asks first, saying what it lets
/// the bot do; off narrows it at once. Only what the package declared is here, so nothing
/// undeclared can be turned on, and a send, a payment or an access change still asks each time.
struct SpadeProfileEffects: View {
    let scope: SpadeProfileScope
    let effects: [SpadePackageLine.Effect]
    /// The package version the switches were read on.
    let hash: String?
    /// Spade sent effects this build can't read.
    var incomplete = false
    /// A switch went: the package is read again.
    let changed: () async -> Void
    @State private var saving: String?
    @State private var granting: Grant?

    /// A switch asked to go on: the effect as the dialog says it, and the version it was read on.
    /// The grant goes with that version, never one read while the dialog was open.
    struct Grant {
        let effect: SpadePackageLine.Effect
        let hash: String
    }
    @State private var problem: String?

    var body: some View {
        Section {
            ForEach(effects) { effect in
                Toggle(isOn: binding(effect)) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        Text(effect.words).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                        ForEach(effect.limits, id: \.self) { limit in
                            Text("Only with \(limit)").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.primary)
                        }
                        Text(effect.eachTime ? "\(effect.why) You decide each time." : effect.why)
                            .aceFont(AceDesign.TextRole.meta)
                            .foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                .disabled(saving != nil || hash == nil)
                .accessibilityIdentifier("spade.effect.\(effect.key)")
            }
        } header: {
            Text("Security")
        } footer: {
            if let problem {
                Text(problem).foregroundStyle(AceTheme.StatusText.failed)
            } else if incomplete {
                Text("It declares more than this ace can show. Change those on the computer.")
            } else {
                Text("What \(scope.name)'s package says it does. Off, it can't.")
            }
        }
        .confirmationDialog(granting.map { _ in "Let \(scope.name) do this?" } ?? "", isPresented: grantingShown,
                            titleVisibility: .visible, presenting: granting) { grant in
            Button("Turn on") { turn(grant.effect, on: true, hash: grant.hash) }
        } message: { grant in
            // Everything the grant allows, its argument limits too: the person grants no more
            // than they read, and Spade takes it only on the version they read it on.
            Text("\(grant.effect.held). \(grant.effect.why)")
        }
    }

    private func binding(_ effect: SpadePackageLine.Effect) -> Binding<Bool> {
        Binding(
            get: { effect.on },
            set: { on in
                // On is a grant: the person reads what it allows first.
                guard let hash else { return }
                if on { granting = Grant(effect: effect, hash: hash) } else { turn(effect, on: false, hash: hash) }
            })
    }

    private var grantingShown: Binding<Bool> {
        Binding(get: { granting != nil }, set: { if !$0 { granting = nil } })
    }

    private func turn(_ effect: SpadePackageLine.Effect, on: Bool, hash: String) {
        guard saving == nil else { return }
        saving = effect.key
        problem = nil
        Task {
            let outcome = await scope.client.spadePackageEffect(scope.agent, key: effect.key, on: on, hash: hash)
            if !outcome.ok { problem = outcome.problem }
            await changed()
            saving = nil
        }
    }
}
