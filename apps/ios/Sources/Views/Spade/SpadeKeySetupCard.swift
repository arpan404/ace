import SwiftUI

/// At the foot of the main Spade's chat while it has no model it can use (web's
/// `spade-key-setup.tsx`): one step picks where it answers from (an endpoint of the person's, a
/// service added as it saves, or a server of their own by its address), takes its key when it
/// needs one, and the model; Spade then answers with it. The key goes once to the machine's
/// keychain and the field empties (ADR 0119). Without a keychain it says where the key goes.
struct SpadeKeySetupCard: View {
    let setup: SpadeOnboarding.Setup
    let save: (_ choice: String, _ key: String?, _ address: String?, _ model: String?) async -> SpadeOnboarding.Answer
    @State private var draft = SpadeKeySetupDraft()
    @State private var saving = false
    @State private var problem: String?

    private var choice: String { draft.picked ?? setup.picked }
    private var option: SpadeOnboarding.Option? { setup.options.first { $0.value == choice } }
    private var keyless: Bool { option?.key == true && !setup.keychain }
    private var typedKey: String { draft.key.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var typedAddress: String { draft.address.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var key: Binding<String> { Binding(get: { draft.key }, set: { draft.key = $0 }) }
    private var address: Binding<String> { Binding(get: { draft.address }, set: { draft.typeAddress($0) }) }
    private var model: Binding<String> { Binding(get: { draft.model }, set: { draft.model = $0 }) }
    private var waiting: Bool {
        guard let option else { return true }
        return (option.key && typedKey.isEmpty) || (option.address && typedAddress.isEmpty)
    }
    private var action: String {
        guard let option else { return "Use this model" }
        return option.address ? "Add server" : option.key ? "Save key" : "Use this model"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.row) {
            HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                StatusGlyph(.needsYou, tone: .needsYou, size: AceDesign.Size.icon)
                RequestHeader(title: setup.title)
            }
            endpointMenu
            if let option {
                if option.address {
                    field("http://localhost:11434/v1/", text: address, id: "spade.setup.address")
                        .keyboardType(.URL)
                    Text("Ollama, LM Studio and most other servers work as they are.")
                        .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                }
                if keyless, let words = setup.keyless {
                    Text(words).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                        .accessibilityIdentifier("spade.setup.keyless")
                } else if option.key || (option.address && setup.keychain) {
                    keyField(optional: option.address)
                }
                // With no models to pick, an id can be typed: a retry after a server listed none.
                if !option.models.isEmpty { modelMenu(option.models) }
                else { field("Model id (optional)", text: model, id: "spade.setup.model") }
            }
            if let problem {
                Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed)
                    .accessibilityIdentifier("spade.setup.problem")
            }
            if !keyless {
                HStack {
                    Spacer(minLength: AceTheme.Spacing.none)
                    Button(saving ? "Saving…" : action, action: submit)
                        .buttonStyle(RequestButtonStyle(primary: true))
                        .disabled(saving || waiting)
                        .accessibilityIdentifier("spade.setup.save")
                }
            }
        }
        .spadeSetupCard(label: setup.title, id: "spade.setup")
    }

    private var endpointMenu: some View {
        Menu {
            ForEach(setup.options) { each in
                Button(each.label) { choose(each.value) }
            }
        } label: {
            menuRow(title: "Endpoint", value: option?.label)
        }
        .disabled(saving)
        .accessibilityIdentifier("spade.setup.endpoint")
    }

    private func modelMenu(_ models: [SpadeOnboarding.ModelChoice]) -> some View {
        Menu {
            ForEach(models) { each in
                Button(each.name) { draft.model = each.id }
            }
        } label: {
            menuRow(title: "Model", value: models.first { $0.id == draft.model }?.name ?? models.first?.name)
        }
        .disabled(saving)
        .accessibilityIdentifier("spade.setup.modelChoice")
    }

    private func menuRow(title: String, value: String?) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            Text(title).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
            Spacer(minLength: AceDesign.Space.related)
            SpadeMenuValue(text: value)
        }
        .frame(minHeight: AceDesign.Size.tap)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func keyField(optional: Bool) -> some View {
        SecureField(optional ? "Key, only if the server asks for one" : "Paste the key", text: key)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .onSubmit(submit)
            .modifier(SpadeSetupField())
            .disabled(saving)
            .accessibilityIdentifier("spade.setup.key")
    }

    private func field(_ prompt: String, text: Binding<String>, id: String) -> some View {
        TextField(prompt, text: text)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .modifier(SpadeSetupField())
            .disabled(saving)
            .accessibilityIdentifier(id)
    }

    private func choose(_ value: String) {
        draft.choose(value, from: choice)
        problem = nil
    }

    private func submit() {
        guard !saving, !waiting else { return }
        // The field lets go of the key as it leaves.
        let sent = draft.takeKey()
        saving = true
        problem = nil
        let chosen = choice
        let server = typedAddress
        let id = draft.model.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            let answer = await save(chosen, sent.isEmpty ? nil : sent, server.isEmpty ? nil : server, id.isEmpty ? nil : id)
            saving = false
            guard !answer.ok else { return }
            problem = answer.problem
            if let made = answer.picked { draft.adopt(made) }
        }
    }
}

/// What the setup card holds as the person types. A pasted key belongs to the endpoint or server
/// it was typed for: choosing another, or changing the address, lets it go, so it can never be
/// saved under, or sent to, a different provider.
struct SpadeKeySetupDraft: Equatable {
    private(set) var picked: String?
    var key = ""
    private(set) var address = ""
    var model = ""

    /// Another endpoint, service or server: the key and model typed for the last one go.
    mutating func choose(_ value: String, from current: String) {
        guard value != current else { return }
        picked = value
        key = ""
        model = ""
    }
    /// The server's address as typed: any change lets the key go.
    mutating func typeAddress(_ text: String) {
        guard text != address else { return }
        address = text
        key = ""
    }
    /// The key, trimmed, for one save; the draft holds it no longer.
    mutating func takeKey() -> String {
        defer { key = "" }
        return key.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    /// A refused save had made its endpoint: that endpoint is the choice now, so a retry never
    /// adds another; the typed model stays for it.
    mutating func adopt(_ made: String) {
        picked = made
        address = ""
        key = ""
    }
}

/// A field inside a setup card: the composer's fill, a tap's height.
struct SpadeSetupField: ViewModifier {
    func body(content: Content) -> some View {
        content
            .aceFont(AceDesign.TextRole.message)
            .padding(.horizontal, AceDesign.Space.row)
            .padding(.vertical, AceDesign.Space.related)
            .frame(minHeight: AceDesign.Size.tap)
            .background(AceDesign.Surface.fill, in: AceDesign.Shape.field)
    }
}

extension View {
    /// A first-run card at the chat's foot: raised, as a card that waits on the person is.
    func spadeSetupCard(label: String, id: String) -> some View {
        padding(AceDesign.Space.margin)
            .background(AceDesign.Surface.raised, in: AceDesign.Shape.container)
            .floatingShadow()
            .accessibilityElement(children: .contain)
            .accessibilityLabel(label)
            .accessibilityIdentifier(id)
    }
}
