import SwiftUI

/// A bot's profile (docs/design/spade.md §4) as a sheet over its chat: its face and name, where
/// it runs, then Details · Permissions · Work · Library · Computer as a segmented control, as
/// web's tabs; at accessibility text sizes, where five segments don't fit, a menu. Each is read
/// from Spade as it shows and again on a pull. The task edits on its own page.
struct SpadeProfileSheet: View {
    let client: ClientModel
    let agent: String
    let name: String
    /// Change on one of its decisions: the words go into its composer, and the sheet closes.
    var quote: (String) -> Void = { _ in }
    /// It was deleted from here: its chat closes too.
    var deleted: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var part: Part = .details
    /// Publish this bot to the Store (#2548).
    @State private var publishing = false
    @State private var reads = SpadeProfileReads()
    @State private var deleting = false
    private var profile: SpadeProfile? { reads.profile }
    private var problem: String? { reads.problem }

    enum Part: String, CaseIterable, Identifiable {
        case details = "Details", permissions = "Permissions", work = "Work", library = "Library", computer = "Computer"
        var id: String { rawValue }
    }

    var body: some View {
        NavigationStack {
            List {
                head
                if let profile {
                    Section { tabs }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets())
                    switch part {
                    case .details:
                        SpadeProfileDetails(client: client, agent: agent, profile: profile, retry: retry, edit: editor)
                    case .permissions:
                        SpadeProfilePermissions(client: client, agent: agent, name: profile.name)
                        SpadeProfileApps(client: client, agent: agent, name: profile.name)
                        SpadeProfilePlugins(client: client, agent: agent)
                        SpadeProfileNetwork(client: client, agent: agent)
                        SpadeProfileCheckpoints(client: client, agent: agent, name: profile.name)
                        SpadeProfileSpending(client: client, agent: agent)
                    case .work:
                        SpadeProfileWork(client: client, agent: agent) { words in
                            quote(words)
                            dismiss()
                        }
                    case .library: SpadeProfileLibrary(library: profile.library, name: profile.name, retry: retry)
                    case .computer: SpadeProfileComputer(client: client, profile: profile, retry: retry)
                    }
                } else if let problem {
                    ProblemRow(problem, id: "spade.profile.problem") { Task { await load() } }
                } else {
                    SkeletonRows(count: 3).listRowInsets(EdgeInsets())
                }
            }
            .listStyle(.insetGrouped)
            .environment(\.spadeProfileScope, SpadeProfileScope(client: client, agent: agent, name: profile?.name ?? name, machine: profile?.details.machine ?? ""))
            .refreshable { await load() }
            .navigationTitle(profile == nil ? name : "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("spade.profile.done")
                }
                if let profile {
                    ToolbarItem(placement: .topBarLeading) {
                        Menu {
                            Button("Publish to the Store", ace: .trayArrowUp) { publishing = true }
                                .disabled(client.connection != "ready" || !client.canOperate)
                                .accessibilityIdentifier("spade.profile.publish")
                            // Spade itself can't be deleted.
                            if !profile.face.main {
                                Button("Delete bot…", role: .destructive) { deleting = true }
                                    .accessibilityIdentifier("spade.profile.delete")
                            }
                        } label: { Image(bar: .dotsThree) }
                            .barGlyph()
                            .accessibilityLabel("More")
                            .accessibilityIdentifier("spade.profile.more")
                    }
                }
            }
            .sheet(isPresented: $publishing) { MarketPublishView(model: client, bot: agent) }
            .modifier(SpadeBotDelete(client: client, agent: agent, name: profile?.name ?? name, asking: $deleting) {
                dismiss()
                deleted()
            })
        }
        .task { await load() }
        .presentationDragIndicator(.visible)
        .accessibilityIdentifier("spade.profile.sheet")
    }

    /// The tabs: five segments, or a menu of them where accessibility text sizes leave no room.
    @ViewBuilder private var tabs: some View {
        let picker = Picker("Part", selection: $part) {
            ForEach(Part.allCases) { Text($0.rawValue).tag($0) }
        }
        if typeSize.isAccessibilitySize {
            picker.pickerStyle(.menu).accessibilityIdentifier("spade.profile.part")
        } else {
            picker.pickerStyle(.segmented).accessibilityIdentifier("spade.profile.part")
        }
    }

    /// The face, large, then the name and where it runs.
    @ViewBuilder private var head: some View {
        if let profile {
            Section {
                VStack(spacing: AceDesign.Space.related) {
                    SpadeFaceView(face: profile.face, size: AceDesign.Size.spade)
                    Text(profile.name)
                        .aceFont(AceDesign.TextRole.header)
                        .foregroundStyle(AceDesign.Ink.primary)
                        .accessibilityAddTraits(.isHeader)
                    Text("On \(profile.details.machine)")
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)
            }
            .listRowBackground(Color.clear)
        }
    }

    /// A part that couldn't be read: the whole profile is read again.
    private func retry() { Task { await load() } }

    private func editor(_ task: String) -> some View {
        SpadeTaskEditor(client: client, agent: agent, task: task) { saved in
            // The saved task shows at once; reads begun before the save are dropped.
            reads.saved(task: saved)
            await load()
        }
    }

    private func load() async {
        let ticket = reads.begin()
        reads.land(await client.spadeProfile(agent), ticket: ticket)
    }
}

/// Details, in web's order: a move to another machine, or what needs the person since one,
/// first (ADR 0187); what the bot is for (its task, which opens to edit), the model and
/// machine it runs with and the models for its other work, its personality, its routines with
/// when each runs, and its notifications. Personality and notifications read together as the
/// tab shows; what can reach and spend sits on Permissions, as on web.
struct SpadeProfileDetails<Editor: View>: View {
    let client: ClientModel
    let agent: String
    let profile: SpadeProfile
    let retry: () -> Void
    @ViewBuilder let edit: (String) -> Editor
    @State private var details: SpadeProfileEdits.Details?
    @State private var move: SpadeMoveFlow?
    @Environment(\.spadeMoveTargets) private var machines
    /// Where it could move: the other machines that run Spade.
    private var targets: [SpadeMoveTarget] { machines.filter { $0.host != client.spade.host } }

    private struct MoveWatch: Equatable {
        let started: Bool
        let id: String?
        let ready: [String]
    }

    var body: some View {
        if let move { SpadeMoveLine(flow: move, targets: targets) }
        SpadeProfileTask(task: profile.details.task, edit: edit)
            .task(id: agent) { if move == nil { move = SpadeMoveFlow(client: client, agent: agent) } }
            .task(id: MoveWatch(started: move != nil, id: move?.moveId, ready: targets.filter(\.ready).map(\.host))) {
                await move?.watch(targets: targets)
            }
            .confirmationDialog(
                "Move \(profile.name)?",
                isPresented: Binding(get: { move?.confirmation != nil }, set: { shown in
                    if !shown { move?.confirmation = nil }
                }),
                titleVisibility: .visible,
                presenting: move?.confirmation
            ) { choice in
                Button("Move to \(choice.target.name)") { Task { await move?.confirm(choice) } }
            } message: { choice in
                Text("\(profile.name) will run on \(choice.target.name) after the move.")
            }
        SpadeProfileRunsWith(client: client, agent: agent, details: profile.details) {
            if let move { SpadeMoveMenu(flow: move, targets: targets, name: profile.name) }
        }
        if let personality = Binding($details)?.personality {
            SpadeProfilePersonality(client: client, agent: agent, personality: personality)
        }
        SpadeProfileRoutines(routines: profile.details.routines, name: profile.name, retry: retry)
            .task(id: agent) {
                let answer = await client.spadeDetails(agent)
                if answer.ok, let fresh = answer.part { details = fresh }
            }
        if let reach = Binding($details).flatMap({ Binding($0.reach) }) {
            SpadeProfileNotifications(client: client, agent: agent, reach: reach)
        }
    }
}
