import SwiftUI

private struct ScriptsReply: Decodable {
    struct Script: Decodable, Identifiable { let id: String; let name: String; let command: String; let source: String; let running: Bool }
    let ok: Bool
    var scripts: [Script]? = nil
    var files: [String]? = nil
    var message: String? = nil
}
private struct PreviewsReply: Decodable {
    struct Preview: Decodable, Identifiable { let port: Int; let url: String; let title: String; var id: Int { port } }
    let ok: Bool
    var previews: [Preview]? = nil
}
private struct RunReply: Decodable { let ok: Bool; var terminalId: String? = nil; var message: String? = nil }
private struct RunningTerminal: Identifiable, Hashable { let id: String }

/// The project's scripts for this thread's checkout, as the web's Run menu: run one in a
/// terminal (one still running opens again instead of starting twice), or edit the file that
/// configures them. The terminal opening is the confirmation.
struct ProjectScriptsView: View {
    let model: ClientModel
    let threadId: String
    /// Opens a dev server in the thread's browser.
    var openPreview: ((String) -> Void)? = nil
    @State private var reply: ScriptsReply?
    @State private var previews: [PreviewsReply.Preview]?
    @State private var problem: String?
    @State private var running: String?
    @State private var terminal: RunningTerminal?
    @State private var editing: FileTarget?
    @State private var started = 0

    var body: some View {
        List {
            if let previews, !previews.isEmpty, let openPreview {
                Section {
                    ForEach(previews) { preview in
                        Button { openPreview(preview.url) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                                    Text(preview.title).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                                    Text("localhost:\(preview.port)").aceMonospace(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                                }
                                Spacer()
                                Text("Open").foregroundStyle(AceTheme.Colours.foreground)
                            }
                            .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("scripts.preview.\(preview.port)")
                    }
                } header: { InsetHeader("Running now") } footer: { Text("Dev servers ace found in this thread. They open in its browser on the computer.") }
                .insetRowBackground()
            }
            Section {
                if let scripts = reply?.scripts {
                    if scripts.isEmpty { Text("This project has no scripts in package.json, a Makefile, a justfile or a Procfile.").foregroundStyle(AceTheme.Colours.mutedForeground) }
                    ForEach(scripts) { script in
                        HStack(spacing: AceTheme.Spacing.sm) {
                            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                                Text(script.name).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                                Text(script.command).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.middle)
                            }
                            Spacer(minLength: AceTheme.Spacing.sm)
                            if running == script.id { ProgressView().controlSize(.small).frame(minWidth: AceTheme.Dimensions.touchTarget) }
                            else {
                                Button(script.running ? "Show" : "Run") { Task { await run(script) } }
                                    .buttonStyle(.borderless).rowButtonTarget()
                                    .disabled(!model.canOperate || running != nil)
                                    .accessibilityIdentifier("scripts.run.\(script.name)")
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                } else if problem == nil {
                    ForEach(0..<4, id: \.self) { _ in
                        VStack(alignment: .leading) { Text("script"); Text("bun run script").font(.caption) }.redacted(reason: .placeholder)
                    }
                    .accessibilityHidden(true)
                }
                if let problem { ServiceProblem(message: problem) }
            } header: { InsetHeader("Scripts") } footer: { Text("Each runs in a terminal in this thread's checkout, on the computer.") }
            .insetRowBackground()
            if let files = reply?.files, !files.isEmpty {
                Section {
                    ForEach(files, id: \.self) { file in
                        Button(file == "package.json" ? "Edit package.json scripts" : "Edit \(file)") { editing = FileTarget(path: file) }
                            .accessibilityIdentifier("scripts.edit.\(file)")
                    }
                } header: { InsetHeader("Configure") }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .smoothChange(reply?.scripts?.map(\.id))
        .smoothChange(previews?.map(\.port))
        .smoothChange(problem)
        .sensoryFeedback(.success, trigger: started)
        .navigationTitle("Run and preview").navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection) { await read() }
        .refreshable { await read() }
        .navigationDestination(item: $terminal) { terminal in TerminalView(model: model, threadId: threadId, initial: terminal.id) }
        .navigationDestination(item: $editing) { target in
            FileScreen(model: model, scope: .thread(threadId), target: target, mention: nil)
        }
    }

    private func read() async {
        guard model.connection == "ready" else { return }
        guard let found = try? await model.service(["type": "native.project", "request": ["op": "scripts", "threadId": threadId]], as: ScriptsReply.self) else {
            problem = "Couldn't reach the machine. Try again."; return
        }
        if found.ok { reply = found; problem = nil } else { problem = found.message }
        previews = (try? await model.service(["type": "native.project", "request": ["op": "previews", "threadId": threadId]], as: PreviewsReply.self))?.previews
    }
    private func run(_ script: ScriptsReply.Script) async {
        running = script.id
        defer { running = nil }
        guard let answer = try? await model.service(["type": "native.project", "request": ["op": "runScript", "threadId": threadId, "scriptId": script.id]], as: RunReply.self) else {
            problem = "Couldn't reach the machine. Try again."; return
        }
        guard answer.ok, let id = answer.terminalId else { problem = answer.message ?? "Couldn't run \(script.name)."; return }
        started += 1
        terminal = RunningTerminal(id: id)
        await read()
    }
}
