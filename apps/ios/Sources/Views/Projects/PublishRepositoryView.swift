import SwiftUI

private struct PublishStatus: Decodable {
    struct Draft: Codable, Equatable { var host: String; var account: String; var owner: String; var name: String; var description: String; var visibility: String }
    struct Publication: Decodable, Equatable { let phase: String; let words: String; let url: String?; let fullName: String?; let problem: String? }
    let ok: Bool
    var message: String? = nil
    var ready: Bool? = nil
    var instructions: String? = nil
    var hosts: [String]? = nil
    var draft: Draft? = nil
    var locked: Bool? = nil
    var publication: Publication? = nil
    var running: Bool? = nil
    var canStop: Bool? = nil
}

/// Publish a project that has no origin as a new GitHub repository, through the machine's own gh
/// login, as the web's Publish repository: name it, choose its owner and visibility, publish.
/// Reopening reads the durable record, so an interrupted publication resumes, never repeats.
struct PublishRepositoryView: View {
    let model: ClientModel
    let project: NativeProject
    let done: () -> Void
    @State private var status: PublishStatus?
    @State private var draft: PublishStatus.Draft?
    @State private var busy = false
    @State private var problem: String?
    @State private var published = 0

    var body: some View {
        Form {
            if let status {
                if status.ready == false {
                    Section { ServiceProblem(message: "\(status.instructions ?? "Sign in to GitHub with gh on the machine.") Then pull to refresh.") }
                        .insetRowBackground()
                }
                if let publication = status.publication { record(publication) }
                // Once published, the record says it all; the form only starts or resumes one.
                if draft != nil, !["empty", "pushed"].contains(status.publication?.phase ?? "") { form(status) }
            } else if problem == nil {
                Section {
                    ForEach(["Owner", "Name", "Description", "Visibility"], id: \.self) { LabeledContent($0) { Text("placeholder") }.redacted(reason: .placeholder) }
                        .accessibilityHidden(true)
                }
                .insetRowBackground()
            }
            if let problem { Section { ServiceProblem(message: problem) }.insetRowBackground() }
        }
        .insetGroupedList()
        .smoothChange(status?.publication)
        .smoothChange(status == nil)
        .smoothChange(problem)
        .sensoryFeedback(.success, trigger: published)
        .disabled(busy)
        .refreshable { await read() }
        .navigationTitle("Publish repository").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button { done() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
            }
            ToolbarItem(placement: .confirmationAction) {
                if busy { ProgressView() } else if let status, status.publication?.phase != "pushed", status.publication?.phase != "empty" {
                    Button(status.locked == true ? "Resume" : "Publish") { Task { await publish() } }
                        .disabled(status.ready != true || status.running == true || draft?.name.isEmpty != false)
                        .accessibilityIdentifier("publish.submit")
                }
            }
        }
        .task { await read() }
    }

    @ViewBuilder private func record(_ publication: PublishStatus.Publication) -> some View {
        Section {
            Text(publication.words).aceFont(InsetStyle.label, relativeTo: .body).accessibilityIdentifier("publish.phase")
            if let url = publication.url.flatMap(URL.init(string:)) {
                Link(publication.fullName ?? url.absoluteString, destination: url)
            }
            if let problem = publication.problem { ServiceProblem(message: problem) }
            if status?.canStop == true {
                Button("Stop publication", role: .destructive) { Task { await stop() } }
            }
        } header: { InsetHeader("Publication") }
        .insetRowBackground()
    }

    @ViewBuilder private func form(_ status: PublishStatus) -> some View {
        let locked = status.locked == true
        Section {
            if let hosts = status.hosts, hosts.count > 1 {
                Picker("Host", selection: binding(\.host)) { ForEach(hosts, id: \.self) { Text($0).tag($0) } }
            }
            LabeledContent("Account") { Text(draft?.account ?? "").foregroundStyle(AceTheme.Colours.mutedForeground) }
            LabeledContent("Owner") {
                TextField("Owner", text: binding(\.owner)).multilineTextAlignment(.trailing).accessibilityIdentifier("publish.owner")
            }
            LabeledContent("Name") {
                TextField("Repository name", text: binding(\.name)).multilineTextAlignment(.trailing).accessibilityIdentifier("publish.name")
            }
            TextField("Description (optional)", text: binding(\.description), axis: .vertical).lineLimit(1...4)
            Picker("Visibility", selection: binding(\.visibility)) {
                Text("Private").tag("private"); Text("Public").tag("public")
            }
            .pickerStyle(.segmented)
        } header: { InsetHeader("New repository") } footer: {
            Text(locked ? "Creation already began, so these stay as they were. Resume to finish." : "Creates the repository with the machine's gh account, adds it as origin and pushes the current branch. ace never rewrites history.")
        }
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .disabled(locked)
        .insetRowBackground()
    }

    private func binding(_ key: WritableKeyPath<PublishStatus.Draft, String>) -> Binding<String> {
        Binding(get: { draft?[keyPath: key] ?? "" }, set: { value in draft?[keyPath: key] = value; problem = nil })
    }
    private func read() async {
        guard let reply = try? await model.service(["type": "native.project", "request": ["op": "publish.status", "workspaceId": project.id, "name": project.name]], as: PublishStatus.self) else {
            problem = "Couldn't read publication status. Pull to refresh."; return
        }
        if reply.ok { status = reply; if draft == nil || reply.locked == true { draft = reply.draft }; problem = nil }
        else { problem = reply.message }
    }
    private func publish() async {
        guard let draft, let input = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) else { return }
        busy = true; problem = nil
        defer { busy = false }
        guard let reply = try? await model.service(["type": "native.project", "request": ["op": "publish", "workspaceId": project.id, "input": input]], as: PublishStatus.self, timeout: .seconds(120)) else {
            problem = "The answer was lost. Pull to refresh to see saved progress, then Resume."; return
        }
        if reply.draft != nil { status = reply; self.draft = reply.draft }
        if reply.ok { published += 1 } else { problem = reply.message }
    }
    private func stop() async {
        busy = true
        defer { busy = false }
        _ = await model.projectWrite(["op": "publish.cancel", "workspaceId": project.id])
        await read()
    }
}
