import SwiftUI

/// A group's profile (ADR 0132, docs/design/spade.md §4) as a sheet over its chat, as web's
/// `spade-group-profile.tsx`: its stacked faces and its name, renamed in place, then Members ·
/// Library. Members lists who is in it with Add a member, Remove (a swipe or a long press) and
/// the lead, who answers what has no @; Library lists the files its members made answering it.
/// Delete asks once and keeps the bots. Each change goes to Spade, and the profile is read again.
struct SpadeGroupProfileSheet: View {
    let client: ClientModel
    let group: String
    /// The name the list has, until the profile is read.
    let name: String
    /// Every bot Add a member may offer, across the machines that show Spade.
    let choices: [SpadeMemberChoice]
    /// The group is gone: its conversation closes.
    let deleted: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var part: Part = .members
    @State private var profile: SpadeGroupProfile.Group?
    @State private var problem: String?
    @State private var saving = false
    @State private var renaming: String?
    @State private var confirmingDelete = false
    @State private var library: SpadeGroupLibrary?
    @FocusState private var nameFocused: Bool

    enum Part: String, CaseIterable, Identifiable {
        case members = "Members", library = "Library"
        var id: String { rawValue }
    }

    /// The group's own machine's ace host id, which members of other machines are named against.
    private var groupHost: String { client.spade.host ?? "" }

    var body: some View {
        NavigationStack {
            List {
                if let profile {
                    head(profile)
                    if let problem { ProblemRow(problem, id: "spade.group.problem") }
                    Section {
                        Picker("Part", selection: $part) {
                            ForEach(Part.allCases) { Text($0.rawValue).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("spade.group.part")
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                    switch part {
                    case .members: members(profile)
                    case .library: SpadeGroupLibraryList(library: library) { Task { await readLibrary() } }
                    }
                } else if let problem {
                    ProblemRow(problem, id: "spade.group.problem") { Task { await load() } }
                } else {
                    SkeletonRows(count: 3).listRowInsets(EdgeInsets())
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await load() }
            .navigationTitle(profile == nil ? name : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("spade.group.done")
                }
            }
        }
        .tint(AceDesign.Ink.action)
        .task { await load() }
        .task(id: part) { if part == .library, library == nil { await readLibrary() } }
        .confirmationDialog("Delete \(profile?.name ?? name)?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete club", role: .destructive) { Task { await delete() } }
                .accessibilityIdentifier("spade.group.delete.confirm")
        } message: {
            Text("This deletes \(profile?.name ?? name) and its conversation. Its bots stay.")
        }
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("spade.group.sheet")
    }

    /// The stacked faces, the lead's first, and the name: a tap makes it a field, Done saves it.
    private func head(_ profile: SpadeGroupProfile.Group) -> some View {
        Section {
            VStack(spacing: AceDesign.Space.row) {
                SpadeGroupFaces(faces: faces(profile), size: AceDesign.Size.tap * 2)
                if let draft = renaming {
                    TextField("Club name", text: Binding(get: { draft }, set: { renaming = String($0.prefix(SpadeGroupDraft.nameMax)) }))
                        .aceFont(AceDesign.TextRole.header)
                        .multilineTextAlignment(.center)
                        .submitLabel(.done)
                        .focused($nameFocused)
                        .onSubmit { Task { await rename(profile) } }
                        .onChange(of: nameFocused) { _, focused in if !focused { Task { await rename(profile) } } }
                        .disabled(saving)
                        .accessibilityIdentifier("spade.group.name.field")
                } else {
                    Button { renaming = profile.name; nameFocused = true } label: {
                        Text(profile.name).aceFont(AceDesign.TextRole.header).foregroundStyle(AceDesign.Ink.primary)
                            .multilineTextAlignment(.center)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Rename \(profile.name)")
                    .accessibilityIdentifier("spade.group.name")
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, AceDesign.Space.related)
        }
        .listRowBackground(Color.clear)
    }

    private func faces(_ profile: SpadeGroupProfile.Group) -> [SpadeModel.Face] {
        let lead = profile.members.filter { SpadeGroupDraft.isLead($0, lead: profile.leadRef) }
        let rest = profile.members.filter { !SpadeGroupDraft.isLead($0, lead: profile.leadRef) }
        return (lead + rest).prefix(3).map(\.face)
    }

    @ViewBuilder private func members(_ profile: SpadeGroupProfile.Group) -> some View {
        let others = SpadeGroupDraft.others(choices, members: profile.members, groupHost: groupHost)
        Section {
            ForEach(profile.members) { member in
                memberRow(member, in: profile)
            }
            if !others.isEmpty {
                Menu {
                    ForEach(others) { choice in
                        Button(choice.host == groupHost ? choice.name : "\(choice.name) on \(choice.machineName)") {
                            Task { await save(members: SpadeGroupDraft.adding(choice, to: profile.members, groupHost: groupHost)) }
                        }
                        .accessibilityIdentifier("spade.group.add.\(choice.id)")
                    }
                } label: { AddRow("Add a member") }
                .disabled(saving)
                .accessibilityIdentifier("spade.group.add")
            }
        } header: {
            InsetHeader("Members")
        }
        let leads = SpadeGroupDraft.leads(profile.members)
        if leads.count > 1 {
            Section {
                Picker("Messages with no @ go to", selection: Binding(get: { profile.lead.agent }, set: { agent in
                    Task { await save(lead: agent) }
                })) {
                    ForEach(leads) { Text($0.name).tag($0.agent) }
                }
                .disabled(saving)
                .accessibilityIdentifier("spade.group.lead")
            } header: {
                InsetHeader("Lead")
            }
        }
        Section {
            Button("Delete club…", role: .destructive) { confirmingDelete = true }
                .disabled(saving)
                .accessibilityIdentifier("spade.group.delete")
        }
    }

    private func memberRow(_ member: SpadeGroupDraft.Member, in profile: SpadeGroupProfile.Group) -> some View {
        let removable = SpadeGroupDraft.removable(member, from: profile.members, lead: profile.leadRef)
        return HStack(spacing: AceDesign.Space.row) {
            SpadeFaceView(face: member.face, size: AceDesign.Size.tap - AceDesign.Space.row)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(member.name).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
                if let line = line(member, in: profile) {
                    Text(line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
                }
            }
        }
        .frame(minHeight: AceDesign.Size.tap)
        .accessibilityElement(children: .combine)
        .swipeActions(edge: .trailing) {
            if removable {
                Button("Remove", role: .destructive) { Task { await save(members: SpadeGroupDraft.removing(member, from: profile.members)) } }
            }
        }
        .contextMenu {
            if removable {
                Button(role: .destructive) { Task { await save(members: SpadeGroupDraft.removing(member, from: profile.members)) } } label: {
                    Label("Remove", ace: .minusCircle)
                }
                .accessibilityIdentifier("spade.group.remove")
            }
        }
        .accessibilityIdentifier("spade.group.member.\(member.id)")
    }

    /// Under a member's name: Lead, Away, or another machine's name.
    private func line(_ member: SpadeGroupDraft.Member, in profile: SpadeGroupProfile.Group) -> String? {
        if SpadeGroupDraft.isLead(member, lead: profile.leadRef) { return "Lead · answers what has no @" }
        if member.away { return "Away" }
        guard let machine = member.machine else { return nil }
        return choices.first { $0.host == machine }?.machineName
    }

    private func load() async {
        let answer = await client.spadeGroupRead(group)
        if let read = answer.group { profile = read; problem = nil } else { problem = answer.problem ?? "Couldn't read the club." }
    }

    private func readLibrary() async { library = await client.spadeGroupFiles(group) }

    private func rename(_ profile: SpadeGroupProfile.Group) async {
        guard let draft = renaming, !saving else { return }
        guard let name = SpadeGroupDraft.rename(draft, from: profile.name) else { renaming = nil; return }
        if await save(name: name) { renaming = nil }
    }

    /// One change; the profile is read again once it went, and a refusal says why.
    @discardableResult private func save(name: String? = nil, members: [SpadeMemberRef]? = nil, lead: String? = nil) async -> Bool {
        saving = true
        defer { saving = false }
        let outcome = await client.spadeGroupEdit(group, name: name, members: members, lead: lead)
        problem = outcome.problem
        if outcome.ok { await load() }
        return outcome.ok
    }

    private func delete() async {
        saving = true
        let outcome = await client.spadeGroupDelete(group)
        saving = false
        if let refused = outcome.problem { problem = refused; return }
        dismiss()
        deleted()
    }
}

/// A group's Library: the files its members made answering it, newest first, each with who made it.
private struct SpadeGroupLibraryList: View {
    let library: SpadeGroupLibrary?
    let retry: () -> Void

    var body: some View {
        Section {
            if let library, let files = library.files {
                if files.isEmpty {
                    Text("Files the members make in this club show here.")
                        .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                }
                ForEach(files) { file in
                    LabeledContent {
                        Text(Date(timeIntervalSince1970: file.at / 1000), format: .relative(presentation: .named))
                            .aceFont(AceDesign.TextRole.meta)
                    } label: {
                        Label { VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                            Text(file.name).lineLimit(1)
                            Text(file.by).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                        } } icon: { AceIcon(.file) }
                    }
                    .accessibilityIdentifier("spade.group.file")
                }
                if let more = library.more, more > 0 {
                    Text("And \(more) more").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                }
            } else if let library {
                ProblemRow(library.problem ?? "Couldn't read the club's files.", id: "spade.group.files.problem", retry: retry)
            } else {
                SkeletonRows(count: 2).listRowInsets(EdgeInsets())
            }
        } header: {
            InsetHeader("Files")
        }
    }
}
