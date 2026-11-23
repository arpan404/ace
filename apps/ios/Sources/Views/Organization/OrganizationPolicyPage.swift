import SwiftUI

/// The policy as the phone's form holds it (`PolicyForm` in `bridge/organization.ts`).
struct OrgPolicyForm: Codable, Equatable {
    var effects: [String: String]
    var fullAccess: String
    var commandsOutsideSandbox: String
    var membersCreateBots: Bool
    var sources: Sources
    var allowlist: Bool
    var allow: String
    var block: String
    var endpoints: String
    var localModels: Bool
    var auditContent: String
    struct Sources: Codable, Equatable { var market: Bool; var registry: Bool; var git: Bool }
}

/// Settings › Organization › Policy (ADR 0206 §3): one versioned document, a ceiling over what the
/// organization's hosts allow anyway, so it only ever narrows. It is edited as web edits it (the
/// lists as lines of text, read and written by the bridge's shared rules) and saved, after a yes,
/// as the next version. Another admin saving first is a refusal that says so; the page then shows
/// what they saved.
struct OrganizationPolicyPage: View {
    let admin: OrganizationAdmin
    let inbox: MachineInbox
    @State private var stored: AceOrgPolicyVersion?
    @State private var form: OrgPolicyForm?
    @State private var problem: String?
    @State private var confirming = false
    @State private var notice: String?
    @State private var changedElsewhere = false

    /// A choice's stored word and what the page calls it.
    private struct Word: Identifiable {
        let id: String
        let label: String
        init(_ id: String, _ label: String) { self.id = id; self.label = label }
    }
    private static let effects = [
        Word("send_as_person", "Send in a member's name"),
        Word("publish", "Publish and post"),
        Word("pay", "Pay"),
        Word("change_access", "Change who has access"),
        Word("network_without_hosts", "Reach sites it doesn't name"),
    ]
    private static let rules = [
        Word("unset", "Each bot decides"), Word("approvers", "Its approvers can turn it on"),
        Word("admins", "Only admins can turn it on"), Word("off", "Never"),
    ]
    private static let raises = [
        Word("unset", "Each bot decides"), Word("approvers", "Its approvers can allow it"),
        Word("admins", "Only admins can allow it"), Word("never", "Never"),
    ]
    private static let keeps = [Word("digests", "Targets and digests"), Word("targets", "Targets only")]

    var body: some View {
        List {
            if let form = Binding($form) { sections(form) }
            else {
                Text(problem ?? "Loading the policy…").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    .insetRowBackground()
            }
        }
        .insetGroupedList()
        .refreshable { await load() }
        .task { await load() }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { confirming = true }
                    .disabled(form == nil || admin.busy)
                    .accessibilityIdentifier("organization.policy.save")
            }
        }
        .confirmationDialog("Save version \((stored?.version ?? 0) + 1)?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Save version \((stored?.version ?? 0) + 1)") { Task { await save() } }
                .accessibilityIdentifier("organization.policy.save.confirm")
        } message: {
            Text("Every one of \(Spaces.possessive(admin.org.name)) hosts takes it the next time it checks.")
        }
        .organizationNotice($notice)
        .alert("The policy changed elsewhere", isPresented: $changedElsewhere) {
            Button("Reload") { Task { await load() } }
                .accessibilityIdentifier("organization.policy.reload")
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("Another admin saved a newer version, so yours wasn't saved. Reload to see theirs, then make your change again.")
        }
    }

    @ViewBuilder private func sections(_ form: Binding<OrgPolicyForm>) -> some View {
        Section {
            ForEach(Self.effects) { effect in
                choice(effect.label, Self.rules, rule(form, effect.id))
            }
            choice("Full access", Self.raises, form.fullAccess)
            choice("Commands outside the sandbox", Self.raises, form.commandsOutsideSandbox)
            Toggle("Members can make shared bots", isOn: form.membersCreateBots)
        } header: {
            InsetHeader("What shared bots may do")
        } footer: {
            footnote("Every send, payment and access change still asks one of the bot's approvers each time.")
        }
        .insetRowBackground()
        Section {
            Toggle("From the Marketplace", isOn: form.sources.market)
            Toggle("From \(Spaces.possessive(admin.org.name)) registry", isOn: form.sources.registry)
            Toggle("From git catalogs", isOn: form.sources.git)
            Toggle("Only listed packages", isOn: form.allowlist)
            lines("Allowed", "One per line: market, registry or git, then the name. registry * allows all of yours.", form.allow)
            lines("Blocked", "One per line: a name, or sha256: and an archive's hash. A bot on a blocked version pauses and says why.", form.block)
        } header: { InsetHeader("Packages") } footer: { footnote("Git catalogs carry no signature.") }
        .insetRowBackground()
        Section {
            lines("Endpoints", "One host per line, such as api.example.com.", form.endpoints)
            Toggle("Models on the host itself", isOn: form.localModels)
        } header: {
            InsetHeader("Models")
        } footer: {
            footnote("Keys stay on each host's keychain. Shared bots never use a member's coding subscription.")
        }
        .insetRowBackground()
        Section {
            choice("What entries keep", Self.keeps, form.auditContent)
        } header: {
            InsetHeader("Audit log")
        } footer: {
            footnote(stored.map { $0.version > 0 ? "Version \($0.version). Never message text, never a member's private work." : "No policy yet." } ?? "")
        }
        .insetRowBackground()
    }

    /// One effect's rule in the form; a key the form doesn't hold reads as "Each bot decides".
    private func rule(_ form: Binding<OrgPolicyForm>, _ key: String) -> Binding<String> {
        Binding(get: { form.wrappedValue.effects[key] ?? "unset" }, set: { form.wrappedValue.effects[key] = $0 })
    }
    private func choice(_ title: String, _ options: [Word], _ value: Binding<String>) -> some View {
        Picker(title, selection: value) {
            ForEach(options) { option in Text(option.label).tag(option.id) }
        }
        .pickerStyle(.menu)
    }
    private func lines(_ title: String, _ hint: String, _ text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text(title).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
            Text(hint).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            TextField(title, text: text, axis: .vertical)
                .lineLimit(3...10)
                .font(AceDesign.Typeface.code)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityLabel(title)
        }
        .padding(.vertical, AceDesign.Space.tight)
    }
    private func footnote(_ text: String) -> some View {
        Text(text).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
    }

    /// A runtime to ask for the shared rules: one of the organization's hosts, else any machine.
    private var client: ClientModel? { (inbox.sessions.first ?? inbox.all.first)?.client }

    private func load() async {
        switch await admin.policy() {
        case .failure(let refused): problem = refused.sentence
        case .success(let version):
            guard let client else { problem = "Connect to one of your machines to edit the policy."; return }
            struct Answer: Decodable { let form: OrgPolicyForm }
            let payload: [String: Any] = ["type": "native.organization", "request": ["op": "policyForm", "body": version.body]]
            do {
                form = try await client.service(payload, as: Answer.self).form
                stored = version; problem = nil
            } catch { problem = "Couldn't read the policy. Try again." }
        }
    }

    private func save() async {
        guard let stored, let form, let client,
              let encoded = try? JSONEncoder().encode(form),
              let fields = try? JSONSerialization.jsonObject(with: encoded) else { return }
        struct Answer: Decodable { let body: String }
        let payload: [String: Any] = ["type": "native.organization",
                                      "request": ["op": "policySave", "body": stored.body, "version": stored.version, "form": fields]]
        guard let answer = try? await client.service(payload, as: Answer.self) else {
            notice = "Couldn't save the policy. Try again."
            return
        }
        switch await admin.savePolicy(body: Data(answer.body.utf8)) {
        case .saved: await load()
        // The edit stays on screen until the person reloads: nothing of it was saved.
        case .changedElsewhere: changedElsewhere = true
        case .refused(let sentence): notice = sentence
        }
    }
}

