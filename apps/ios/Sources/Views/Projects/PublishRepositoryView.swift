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
        List {
            if let problem {
                Section { ProblemRow(problem, id: "publish.problem") { Task { await read() } } }
            }
            if let status {
                if status.ready == false {
                    Section {
                        ProblemRow("GitHub isn't signed in on this computer.", detail: status.instructions ?? "Sign in with gh on the computer, then check again.",
                                   id: "publish.signin", retryLabel: "Check again") { Task { await read() } }
                    }
                }
                if let publication = status.publication { record(publication) }
                // Once published, the record says it all; the form only starts or resumes one.
                if draft != nil, status.publication?.phase != "pushed" { form(status) }
            } else if problem == nil {
                Section {
                    ForEach(["Owner", "Name", "Description", "Visibility"], id: \.self) { LabeledContent($0) { Text("placeholder") }.redacted(reason: .placeholder) }
                        .accessibilityHidden(true)
                }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .smoothChange(status?.publication)
        .smoothChange(status == nil)
        .smoothChange(problem)
        .sensoryFeedback(.success, trigger: published)
        .refreshable { await read() }
        .navigationTitle("Publish repository").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button { done() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
            }
            ToolbarItem(placement: .confirmationAction) {
                if busy { WorkingMark() } else if let status, status.publication?.phase != "pushed" {
                    Button(status.locked == true ? "Resume" : "Publish") { Task { await publish() } }
                        .disabled(status.ready != true || status.running == true || draft?.name.isEmpty != false)
                        .accessibilityIdentifier("publish.submit")
                }
            }
        }
        .task {
            await read()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                if status?.running == true || busy { await read() }
            }
        }
    }

    @ViewBuilder private func record(_ publication: PublishStatus.Publication) -> some View {
        Section {
            Text(publication.words).aceFont(AceDesign.TextRole.rowTitle).accessibilityIdentifier("publish.phase")
            if let url = publication.url.flatMap(URL.init(string:)) {
                Link(publication.fullName ?? url.absoluteString, destination: url)
            }
            if let problem = publication.problem {
                Text(problem).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed)
                    .accessibilityIdentifier("publish.failure")
            }
            if status?.canStop == true {
                Button("Stop publication", role: .destructive) { Task { await stop() } }.buttonStyle(.rowAction)
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
            LabeledContent("Account") { Text(draft?.account ?? "").foregroundStyle(AceDesign.Ink.muted) }
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
            Text(locked ? "Creation already began, so these stay as they were. Resume to finish." : "Creates the repository with the computer's gh account, adds it as origin and pushes the current branch.")
        }
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .disabled(locked || busy || status.running == true)
        .insetRowBackground()
    }

    private func binding(_ key: WritableKeyPath<PublishStatus.Draft, String>) -> Binding<String> {
        Binding(get: { draft?[keyPath: key] ?? "" }, set: { value in draft?[keyPath: key] = value; problem = nil })
    }
    private func read() async {
        guard let reply = try? await model.service(["type": "native.project", "request": ["op": "publish.status", "workspaceId": project.id, "name": project.name]], as: PublishStatus.self) else {
            problem = "Couldn't read publication status."; return
        }
        if reply.ok { status = reply; if draft == nil || reply.locked == true { draft = reply.draft }; problem = nil }
        else { problem = reply.message }
    }
    private func publish() async {
        guard let draft, let input = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(draft)) else { return }
        busy = true; problem = nil
        defer { busy = false }
        guard let reply = try? await model.service(["type": "native.project", "request": ["op": "publish", "workspaceId": project.id, "input": input]], as: PublishStatus.self, timeout: .seconds(120)) else {
            problem = "Couldn't confirm the publication. Try again to read its progress, then Resume."; return
        }
        if reply.draft != nil { status = reply; self.draft = reply.draft }
        if reply.ok { published += 1 } else { problem = reply.message }
    }
    private func stop() async {
        busy = true
        defer { busy = false }
        let answer = await model.projectWrite(["op": "publish.cancel", "workspaceId": project.id])
        await read()
        if !answer.ok { problem = answer.message ?? "Couldn't stop publication. Try again." }
    }
}
