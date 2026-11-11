import SwiftUI

/// What `bridge/project-repository-settings.ts` sends: each repository with its words and the
/// changes it allows. Swift derives nothing.
private struct RepositoriesReply: Decodable {
    struct Row: Decodable, Identifiable, Equatable {
        let id: String
        let repository: ForgeRepository
        let forge: String
        let label: String
        let line: String
        let primary: Bool
        let visible: Bool
        let available: Bool
        let canMakePrimary: Bool
        let canHide: Bool
        let canShow: Bool
        let canRemove: Bool
    }
    let ok: Bool
    var rows: [Row]? = nil
    var message: String? = nil
}

/// A project's Git repositories (ADR 0116): its remotes on known hosts and the ones added by
/// hand, each with its host's mark and where it comes from. The primary is where new pull
/// requests open; a hidden one is left out of Code review. Changes are a row's menu or swipe.
struct ProjectRepositoriesView: View {
    let model: ClientModel
    let project: NativeProject
    @State private var rows: [RepositoriesReply.Row] = []
    @State private var loaded = false
    @State private var typed = ""
    @State private var problem: String?
    @State private var busy = false
    @State private var changes = 0

    var body: some View {
        List {
            Section {
                if loaded && rows.isEmpty {
                    Text("No remote of this project is on one of your Git hosts.").foregroundStyle(AceDesign.Ink.muted)
                }
                ForEach(rows) { row in
                    rowView(row)
                        .contextMenu { if model.canOperate { actions(row) } }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if model.canOperate {
                                if row.canRemove {
                                    Button("Remove", role: .destructive) { change("remove", row) }
                                }
                                if row.canHide { Button("Hide") { change("hide", row) }.tint(Color(uiColor: .systemGray2)) }
                                if row.canShow { Button("Show") { change("show", row) } }
                            }
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            if model.canOperate, row.canMakePrimary {
                                Button("Make primary") { change("primary", row) }.tint(AceDesign.Ink.accent)
                            }
                        }
                }
                if !loaded, problem == nil { SkeletonRows(count: 2, label: "Reading repositories").listRowInsets(EdgeInsets()) }
            } header: { InsetHeader("Repositories") } footer: {
                Text("New pull requests open on the primary. Hidden repositories stay out of Code review.")
            }
            .insetRowBackground()
            if model.canOperate {
                Section {
                    TextField("https://gitlab.com/owner/name", text: $typed)
                        .font(AceDesign.Typeface.code)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.done).onSubmit { Task { await add() } }
                        .accessibilityIdentifier("repositories.address")
                    Button("Add repository") { Task { await add() } }
                        .disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityIdentifier("repositories.add")
                } header: { InsetHeader("Add a repository") } footer: {
                    Text("An https or SSH address on one of your Git hosts. It needn't be a remote of this project.")
                }
                .insetRowBackground()
            }
            if let problem { Section { ServiceProblem(message: problem) }.insetRowBackground() }
        }
        .insetGroupedList()
        .smoothChange(rows)
        .smoothChange(loaded)
        .smoothChange(problem)
        .sensoryFeedback(.success, trigger: changes)
        .disabled(busy)
        .navigationTitle("Repositories").navigationBarTitleDisplayMode(.inline)
        .task(id: model.readGeneration(ProjectsView.firstPage)) { await read() }
        .refreshable { await read() }
    }

    private func rowView(_ row: RepositoriesReply.Row) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            GitHostMark(forge: row.forge)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.label).font(AceDesign.Typeface.body)
                    .foregroundStyle(row.visible && row.available ? AceDesign.Ink.primary : AceDesign.Ink.muted)
                    .lineLimit(1).truncationMode(.middle)
                Text(row.line).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted).lineLimit(2)
            }
            Spacer(minLength: AceDesign.Space.related)
            if row.primary {
                Text("Primary").font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                    .accessibilityIdentifier("repositories.primary")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("repositories.row.\(row.label)")
    }

    @ViewBuilder private func actions(_ row: RepositoriesReply.Row) -> some View {
        if row.canMakePrimary { Button("Make primary", systemImage: "star") { change("primary", row) } }
        if row.canHide { Button("Hide", systemImage: "eye.slash") { change("hide", row) } }
        if row.canShow { Button("Show", systemImage: "eye") { change("show", row) } }
        if row.canRemove { Button("Remove", systemImage: "trash", role: .destructive) { change("remove", row) } }
    }

    private func read() async {
        guard model.connection == "ready" else { return }
        do {
            let reply = try await model.service(["type": "native.project", "request": ["op": "repositories.read", "workspaceId": project.id]], as: RepositoriesReply.self)
            if reply.ok, let fresh = reply.rows { rows = fresh; loaded = true; problem = nil }
            else { problem = reply.message }
        } catch { problem = error.localizedDescription }
    }

    private func change(_ kind: String, _ row: RepositoriesReply.Row) {
        Task {
            await write(["op": "repositories.change", "workspaceId": project.id, "change": kind, "repository": row.repository.json])
        }
    }

    private func add() async {
        let address = typed.trimmingCharacters(in: .whitespaces)
        guard !address.isEmpty else { return }
        if await write(["op": "repositories.add", "workspaceId": project.id, "address": address]) { typed = "" }
    }

    /// One saved change, answered once the computer took or refused it; the list is read again either way.
    @discardableResult private func write(_ request: [String: Any]) async -> Bool {
        guard model.canOperate else { return false }
        busy = true; problem = nil
        defer { busy = false }
        let outcome = await model.projectWrite(request)
        if outcome.ok { changes += 1 } else { problem = outcome.message ?? "Couldn't save that. Try again." }
        await read()
        return outcome.ok
    }
}
