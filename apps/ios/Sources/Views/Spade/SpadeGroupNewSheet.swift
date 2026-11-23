import SwiftUI

/// New club, a group of bots (ADR 0132, docs/design/spade.md §5), as web's `spade-group-new.tsx`:
/// the members' faces and the club's name, then its members (searched past eight bots), Spade
/// picked to start with, then the lead, who answers what has no @. The group is made on its lead's machine; made, the sheet closes on its
/// conversation. Every rule is `SpadeGroupDraft`'s.
struct SpadeGroupNewSheet: View {
    /// Every bot the group may hold, across the machines that show Spade.
    let choices: [SpadeMemberChoice]
    /// The machine Spade shows from: its Spade starts picked.
    let spadeOn: String?
    /// The client of a machine, by its inbox key.
    let client: (String) -> ClientModel?
    /// The group was made: its conversation opens, on the lead's machine.
    let made: (SpadeRoute) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var picked: [String] = []
    @State private var asked: String?
    @State private var making = false
    @State private var problem: String?
    @State private var started = false
    @State private var query = ""

    private var members: [SpadeMemberChoice] { SpadeGroupDraft.picked(choices, picked) }
    private var lead: SpadeMemberChoice? { SpadeGroupDraft.lead(members, asked: asked) }
    private var blocked: String? { SpadeGroupDraft.problem(name: name, picked: members, lead: lead) }
    private var severalMachines: Bool { Set(choices.map(\.machine)).count > 1 }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: AceDesign.Space.row) {
                        SpadeGroupFaces(faces: faces, size: AceDesign.Size.tap * 2)
                            .frame(maxWidth: .infinity)
                        TextField("Club name", text: $name)
                            .aceFont(AceDesign.TextRole.header)
                            .multilineTextAlignment(.center)
                            .submitLabel(.done)
                            .disabled(making)
                            .onChange(of: name) { _, typed in
                                if typed.count > SpadeGroupDraft.nameMax { name = String(typed.prefix(SpadeGroupDraft.nameMax)) }
                            }
                            .accessibilityIdentifier("spade.newgroup.name")
                    }
                    .padding(.vertical, AceDesign.Space.related)
                }
                Section {
                    ForEach(SpadeGroupDraft.shown(choices, query: query, picked: Set(picked))) { memberRow($0) }
                } header: {
                    InsetHeader("Members")
                } footer: {
                    if let problem {
                        Text(problem).foregroundStyle(AceTheme.StatusText.failed).accessibilityIdentifier("spade.newgroup.problem")
                    } else if let blocked, !name.trimmingCharacters(in: .whitespaces).isEmpty || picked.count > 1 {
                        Text(blocked).accessibilityIdentifier("spade.newgroup.blocked")
                    }
                }
                if members.count > 1, let lead {
                    Section {
                        Picker("Messages with no @ go to", selection: Binding(get: { lead.id }, set: { asked = $0 })) {
                            ForEach(members) { Text($0.name).tag($0.id) }
                        }
                        .disabled(making)
                        .accessibilityIdentifier("spade.newgroup.lead")
                    } header: {
                        InsetHeader("Lead")
                    } footer: {
                        Text(severalMachines ? "The club lives on \(lead.machineName), its lead's machine." : "The lead answers what has no @.")
                    }
                }
            }
            .modifier(SpadeMemberSearch(on: choices.count >= SpadeGroupDraft.searchFrom, query: $query))
            .navigationTitle("New club")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(making || !name.isEmpty)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(making).accessibilityIdentifier("spade.newgroup.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    if making { ProgressView() } else {
                        Button("Create", action: create)
                            .fontWeight(AceDesign.Typeface.strong)
                            .disabled(blocked != nil)
                            .accessibilityIdentifier("spade.newgroup.create")
                    }
                }
            }
        }
        .tint(AceDesign.Ink.action)
        .onAppear {
            guard !started else { return }
            started = true
            picked = SpadeGroupDraft.start(choices, spadeOn: spadeOn)
        }
    }

    /// The faces at the top: the lead's first, then the rest picked, three at most.
    private var faces: [SpadeModel.Face] {
        let rest = members.filter { $0.id != lead?.id }
        return ((lead.map { [$0] } ?? []) + rest).prefix(3).map(\.face)
    }

    private func memberRow(_ choice: SpadeMemberChoice) -> some View {
        let on = picked.contains(choice.id)
        return Button {
            if on { picked.removeAll { $0 == choice.id } } else { picked.append(choice.id) }
            problem = nil
        } label: {
            HStack(spacing: AceDesign.Space.row) {
                SpadeFaceView(face: choice.face, size: AceDesign.Size.tap - AceDesign.Space.row)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(choice.name).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
                    if let line = line(choice) {
                        Text(line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
                    }
                }
                Spacer(minLength: AceDesign.Space.related)
                if on { AceIcon(.check).foregroundStyle(AceDesign.Ink.action).accessibilityHidden(true) }
            }
            .frame(minHeight: AceDesign.Size.tap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(making)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("spade.newgroup.member.\(choice.id)")
    }

    /// Under a member's name: its machine while there are several, and Away while it doesn't answer.
    private func line(_ choice: SpadeMemberChoice) -> String? {
        let words = [severalMachines ? choice.machineName : nil, choice.away ? "Away" : nil].compactMap(\.self)
        return words.isEmpty ? nil : words.joined(separator: " · ")
    }

    private func create() {
        guard blocked == nil, let lead, let client = client(lead.machine) else { return }
        making = true
        problem = nil
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let refs = SpadeGroupDraft.refs(members, on: lead.host)
        Task {
            let answer = await client.spadeGroupCreate(name: trimmed, members: refs, lead: lead.agent)
            making = false
            if let new = answer.made {
                dismiss()
                made(SpadeRoute(conversation: new.conversation, group: new.group, machine: lead.machine))
            } else {
                problem = answer.problem ?? "Couldn't make the club."
            }
        }
    }
}

/// The member list's search field, once there are more bots than fit at a glance.
private struct SpadeMemberSearch: ViewModifier {
    let on: Bool
    @Binding var query: String
    func body(content: Content) -> some View {
        if on { content.searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search bots") }
        else { content }
    }
}
