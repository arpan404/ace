import SwiftUI

private struct ReposContext: Decodable {
    let ready: Bool
    let instructions: String?
    let hosts: [String]
    let host: String
    let account: String
}
struct GitHubRepository: Decodable, Identifiable, Hashable {
    let id: Int
    let fullName: String
    let name: String
    let description: String
    let `private`: Bool
    let archived: Bool
    let fork: Bool
    let cloneUrl: String
}
private struct ReposReply: Decodable {
    let ok: Bool
    var repositories: [GitHubRepository]? = nil
    var message: String? = nil
}

/// Pick a repository to clone from the GitHub account the machine's own gh CLI is signed in to,
/// as the web's Add project › GitHub: search, filter by visibility and forks, pick one.
struct GitHubRepositoriesView: View {
    let model: ClientModel
    let picked: (GitHubRepository) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var context: ReposContext?
    @State private var host = ""
    @State private var account = ""
    @State private var owner = ""
    @State private var query = ""
    @State private var visibility = "all"
    @State private var forks = "all"
    @State private var rows: [GitHubRepository]?
    @State private var problem: String?

    var body: some View {
        List {
            if let context, !context.ready {
                Section { ServiceProblem(message: context.instructions ?? "Sign in to GitHub with gh on the machine.") }
                    .insetRowBackground()
            }
            Section {
                if let rows {
                    if rows.isEmpty { Text(query.isEmpty ? "No repositories." : "No repositories match \(query).").foregroundStyle(AceTheme.Colours.mutedForeground) }
                    ForEach(rows) { row in
                        Button { picked(row); dismiss() } label: {
                            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                                Text(row.fullName).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                                let facts = [row.private ? "Private" : "Public", row.archived ? "Archived" : nil, row.fork ? "Fork" : nil, row.description.isEmpty ? nil : row.description].compactMap { $0 }
                                Text(facts.joined(separator: " · ")).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
                            }
                            .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("github.repo.\(row.fullName)")
                    }
                } else if context?.ready != false, problem == nil {
                    // The rows' own shape while the machine asks GitHub.
                    ForEach(0..<6, id: \.self) { _ in
                        VStack(alignment: .leading) { Text("owner/repository"); Text("Private · a description") .font(.caption) }
                            .redacted(reason: .placeholder)
                    }
                    .accessibilityHidden(true)
                }
                if let problem { ServiceProblem(message: problem) }
            } header: {
                if let context, context.ready { InsetHeader("\(account.isEmpty ? context.account : account) on \(host)") }
            }
            .insetRowBackground()
            if let context, context.ready {
                Section {
                    if context.hosts.count > 1 {
                        Picker("Host", selection: $host) { ForEach(context.hosts, id: \.self) { Text($0).tag($0) } }
                    }
                    TextField("Owner (optional)", text: $owner).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("Visibility", selection: $visibility) {
                        Text("All").tag("all"); Text("Public").tag("public"); Text("Private").tag("private")
                    }
                    Picker("Forks", selection: $forks) {
                        Text("Include forks").tag("all"); Text("Exclude forks").tag("no"); Text("Only forks").tag("yes")
                    }
                } header: { InsetHeader("Filters") }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .smoothChange(rows?.map(\.id))
        .smoothChange(problem)
        .searchable(text: $query, prompt: "Search repositories")
        .navigationTitle("GitHub").navigationBarTitleDisplayMode(.inline)
        .task { await readContext() }
        // Typing waits a moment so each keystroke doesn't ask GitHub again.
        .task(id: [host, account, owner, query, visibility, forks].joined(separator: "\n")) {
            guard context?.ready == true else { return }
            try? await Task.sleep(for: .milliseconds(query.isEmpty ? 0 : 300))
            guard !Task.isCancelled else { return }
            await list()
        }
    }

    private func readContext() async {
        guard let found = try? await model.service(["type": "native.project", "request": ["op": "repos.context"]], as: ReposContext.self) else {
            problem = "Couldn't reach the machine. Try again."; return
        }
        context = found
        host = found.host; account = found.account
        if found.ready { await list() }
    }
    private func list() async {
        var request: [String: Any] = ["op": "repos.list", "host": host, "account": account, "query": query, "visibility": visibility, "archived": "no", "fork": forks]
        if !owner.isEmpty { request["owner"] = owner }
        guard let reply = try? await model.service(["type": "native.project", "request": request], as: ReposReply.self) else {
            problem = "Couldn't reach the machine. Try again."; return
        }
        if reply.ok { rows = reply.repositories ?? []; problem = nil } else { problem = reply.message }
    }
}
