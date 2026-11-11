import SwiftUI

/// An outside app (claude.ai, a bot) asking to sign in to a paired machine (ADR 0117). The
/// person is often away from the computer when the app asks, so the request opens here as a
/// system sheet from anywhere in the app: who asks, the match code to compare with the app's
/// sign-in page, then what it may do, which projects and how long. Swiping it away puts it
/// aside until it ends; Deny and Approve answer the machine.
struct OutsideAccessPrompt: ViewModifier {
    let inbox: MachineInbox

    func body(content: Content) -> some View {
        let asking = inbox.sessions.lazy.compactMap { session in
            session.client.outside.asking.map { Asking(hostId: session.hostId, client: session.client, request: $0) }
        }.first
        content.sheet(item: Binding(get: { asking }, set: { if $0 == nil, let asking { asking.client.outside.setAside.insert(asking.request.requestId) } })) { asking in
            NavigationStack {
                OutsideAccessSheet(client: asking.client, request: asking.request,
                                   machine: inbox.names[asking.hostId] ?? "this machine")
            }
            .tint(AceDesign.Ink.accent)
            .presentationDetents([.large]).presentationDragIndicator(.visible)
        }
    }
    struct Asking: Identifiable {
        let hostId: String
        let client: ClientModel
        let request: OutsideClientsModel.Access
        var id: String { "\(hostId)/\(request.requestId)" }
    }
}

extension View {
    func outsideAccessPrompt(_ inbox: MachineInbox) -> some View { modifier(OutsideAccessPrompt(inbox: inbox)) }
}

struct OutsideAccessSheet: View {
    let client: ClientModel
    let request: OutsideClientsModel.Access
    let machine: String
    @State private var scopes: Set<String>
    @State private var allProjects = true
    @State private var chosen: Set<String> = []
    @State private var expiry: String?
    @State private var projects: [ConnectedApps.Project] = []
    @State private var problem: String?
    @State private var answering: String?
    @State private var approved = 0

    init(client: ClientModel, request: OutsideClientsModel.Access, machine: String) {
        self.client = client
        self.request = request
        self.machine = machine
        _scopes = State(initialValue: Set(request.choices.filter(\.on).map(\.scope)))
        _expiry = State(initialValue: request.expiry)
    }

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text(request.grantId == nil ? "\(request.clientName) wants to sign in to \(machine)"
                                                : "\(request.clientName) asks for more access on \(machine)")
                        .font(AceDesign.Typeface.title.weight(AceDesign.Typeface.strong))
                        .foregroundStyle(AceDesign.Ink.primary)
                        .fixedSize(horizontal: false, vertical: true)
                    Label(request.domain, systemImage: request.verified ? "checkmark.seal" : "questionmark.circle")
                        .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                        .accessibilityIdentifier("outside.domain")
                }
                .padding(.vertical, AceDesign.Space.tight)
            }
            .insetRowBackground()
            Section {
                Text(request.matchCode)
                    .font(AceDesign.Typeface.codeBody.weight(AceDesign.Typeface.strong))
                    .tracking(4)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, AceDesign.Space.related)
                    .accessibilityLabel("Match code \(request.matchCode.map(String.init).joined(separator: " "))")
                    .accessibilityIdentifier("outside.matchCode")
            } header: { InsetHeader("Match code") } footer: {
                Text("Approve only if the app's sign-in page shows this same code. The request ends at \(Date(timeIntervalSince1970: request.expiresAt / 1000).formatted(date: .omitted, time: .shortened)).")
            }
            .insetRowBackground()
            OutsideAccessSections(choices: request.choices, scopes: $scopes, projects: projects,
                                  allProjects: $allProjects, chosen: $chosen, expiries: request.expiries, expiry: $expiry)
            if let problem { Section { ServiceProblem(message: problem) }.insetRowBackground() }
        }
        .insetGroupedList()
        .disabled(answering != nil)
        .sensoryFeedback(.success, trigger: approved)
        .navigationTitle("Sign-in request").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if answering == "deny" { WorkingMark(label: "Denying") } else {
                    Button("Deny", role: .destructive) { Task { await answer(approve: false) } }
                        .accessibilityIdentifier("outside.deny")
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                if answering == "approve" { WorkingMark(label: "Approving") } else {
                    Button("Approve") { Task { await answer(approve: true) } }
                        .disabled(OutsideAccessSections.wire(all: allProjects, chosen: chosen) == nil)
                        .accessibilityIdentifier("outside.approve")
                }
            }
        }
        .task { projects = await client.outsideProjects(machine: machine) }
    }

    private func answer(approve: Bool) async {
        answering = approve ? "approve" : "deny"; problem = nil
        defer { answering = nil }
        var decision: [String: Any] = ["op": "decide", "requestId": request.requestId, "approve": approve]
        if approve {
            decision["scopes"] = request.choices.map(\.scope).filter { scopes.contains($0) }
            decision["projects"] = OutsideAccessSections.wire(all: allProjects, chosen: chosen)
            if let expiry { decision["expiry"] = expiry }
        }
        // Once the machine takes it, the request leaves `outside.state` and the sheet closes.
        if let refusal = await client.outsideChange(decision, machine: machine) { problem = refusal }
        else if approve { approved += 1 }
    }
}
