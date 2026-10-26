import SwiftUI

/// A pull request's reviewers (the web's Reviewers list): each person or team with where they
/// stand, and a ⋯ menu with Re-request, Remove request or Dismiss review where GitHub lets this
/// account. Request review opens GitHub's suggestions and a search of the repository's people.
struct ForgeReviewersSection: View {
    let desk: ForgeReviewDesk
    let compose: (ForgeCompose) -> Void
    @State private var reviewers: ForgeReviewers?
    @State private var requesting = false
    private var client: ClientModel { desk.client }
    private var request: [String: Any] { ClientModel.forgeReviewersRead(project: desk.target.project, number: desk.target.number) }

    init(desk: ForgeReviewDesk, compose: @escaping (ForgeCompose) -> Void) {
        self.desk = desk
        self.compose = compose
        _reviewers = State(initialValue: desk.client.kept(ClientModel.forgeReviewersRead(project: desk.target.project, number: desk.target.number), as: ForgeReviewers.self))
    }

    var body: some View {
        // A stack, not a group: the read below must run while there is nothing to show yet.
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if let reviewers, !reviewers.rows.isEmpty || reviewers.canRequest {
                ForgeSection(title: "Reviewers") {
                    ForEach(reviewers.rows) { row in rowView(row) }
                    if reviewers.canRequest, client.canOperate {
                        Button("Request review") { requesting = true }
                            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                            .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 44)
                            .disabled(!desk.ready)
                            .accessibilityIdentifier("forge.reviewers.request")
                    }
                }
            }
        }
        .task(id: client.readGeneration(request)) { await load() }
        .sheet(isPresented: $requesting) {
            ForgeRequestReviewSheet(desk: desk, suggested: reviewers?.suggested ?? [], asked: Set(reviewers?.rows.map(\.name) ?? []))
        }
    }

    private func rowView(_ row: ForgeReviewers.Row) -> some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            AceIcon(row.kind == "team" ? .users : .user, size: 15, relativeTo: .subheadline).foregroundStyle(AceTheme.Colours.subtleForeground)
            Text(row.label).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            Spacer(minLength: AceTheme.Spacing.sm)
            Text(row.words).meta(row.tone.map { AceTone($0).text } ?? AceTheme.Colours.mutedForeground)
            if (row.canRerequest || row.canRemove || row.canDismiss), client.canOperate {
                Menu {
                    if row.canRerequest { Button("Re-request review", ace: .arrowClockwise) { ask(row, kind: "reviewers.request") } }
                    if row.canRemove { Button("Remove request", ace: .x) { ask(row, kind: "reviewers.remove") } }
                    if row.canDismiss, let id = row.reviewId { Button("Dismiss review", ace: .prohibit) { dismiss(row, reviewId: id) } }
                } label: { Image(ace: .dotsThree).frame(width: 32, height: 32).contentShape(Rectangle()) }
                    .disabled(!desk.ready)
                    .accessibilityLabel("Actions for \(row.label)")
                    .accessibilityIdentifier("forge.reviewer.\(row.name)")
            }
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .frame(minHeight: 44)
    }

    private func ask(_ row: ForgeReviewers.Row, kind: String) {
        let action: [String: Any] = row.kind == "team"
            ? ["kind": kind, "reviewers": [String](), "teams": [row.name]]
            : ["kind": kind, "reviewers": [row.name]]
        Task { await desk.run(action) }
    }

    private func dismiss(_ row: ForgeReviewers.Row, reviewId: Int) {
        let desk = desk
        compose(ForgeCompose(
            title: "Dismiss \(row.label)'s review", text: "", placeholder: "Why it no longer applies",
            primary: .init(label: "Dismiss review") { message in
                await desk.run(["kind": "review.dismiss", "reviewId": reviewId, "message": message])
            }))
    }

    private func load() async {
        do { reviewers = try await client.forgeReviewers(project: desk.target.project, number: desk.target.number) }
        catch {}
    }
}

/// Ask someone to review: GitHub's suggestions first, then whoever the search finds among the
/// repository's people. A pick sends the request at once.
struct ForgeRequestReviewSheet: View {
    let desk: ForgeReviewDesk
    let suggested: [ForgeReviewers.Person]
    let asked: Set<String>
    @State private var query = ""
    @State private var found: [ForgeCompletions.Item] = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if query.isEmpty {
                    if !suggested.isEmpty {
                        Section("Suggested") {
                            ForEach(suggested, id: \.login) { person in pickRow(person.login, person.name ?? "") }
                        }
                    }
                } else {
                    ForEach(found, id: \.self) { item in pickRow(String(item.label.dropFirst()), item.detail) }
                }
                if let message = desk.message { Text(message).foregroundStyle(AceTone.failed.text) }
            }
            .listStyle(.plain)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search people")
            .task(id: query) { await search() }
            .navigationTitle("Request review")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .onAppear { desk.clearMessage() }
        .presentationDetents([.medium, .large])
    }

    private func pickRow(_ login: String, _ name: String) -> some View {
        Button {
            Task { if await desk.run(["kind": "reviewers.request", "reviewers": [login]]) { dismiss() } }
        } label: {
            HStack {
                Text(login).foregroundStyle(AceTheme.Colours.foreground)
                Text(name).foregroundStyle(AceTheme.Colours.mutedForeground)
                Spacer()
                if asked.contains(login) { Text("Asked").meta() }
            }
        }
        .disabled(!desk.ready || asked.contains(login))
        .accessibilityIdentifier("forge.request.\(login)")
    }

    /// The people search `@` uses, so both find the same people.
    private func search() async {
        let typed = query.trimmingCharacters(in: .whitespaces)
        guard !typed.isEmpty else { found = []; return }
        try? await Task.sleep(for: .milliseconds(180))
        guard !Task.isCancelled else { return }
        let text = "@" + typed.replacingOccurrences(of: " ", with: "")
        let items = await desk.completer.suggestions(text: text, start: text.utf16.count, end: text.utf16.count)
        if !Task.isCancelled { found = items }
    }
}
