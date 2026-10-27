import SwiftUI

private struct FoldersReply: Decodable {
    struct Folder: Decodable, Identifiable { let path: String; let name: String; var id: String { path } }
    let folders: [Folder]
}
private struct AllowReply: Decodable {
    let ok: Bool
    var message: String? = nil
    var path: String? = nil
    var name: String? = nil
    var canCreate: Bool? = nil
}

/// The folders this machine may open projects in, as the web's Settings › Project folders: allow
/// another by its path (`~` is the machine's home; a missing one is offered for creating), or
/// stop allowing one. Folders and projects on disk are never touched.
struct ProjectFoldersView: View {
    let model: ClientModel
    @State private var folders: [FoldersReply.Folder] = []
    @State private var loaded = false
    @State private var typed = ""
    @State private var missing: (typed: String, path: String, name: String)?
    @State private var removing: FoldersReply.Folder?
    @State private var problem: String?
    @State private var busy = false

    var body: some View {
        List {
            Section {
                if loaded && folders.isEmpty { Text("Any folder in the machine's home.").foregroundStyle(AceTheme.Colours.mutedForeground) }
                ForEach(folders) { folder in
                    HStack(spacing: AceTheme.Spacing.sm) {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                            Text(folder.name).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                            Text(folder.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                                .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.middle)
                        }
                        Spacer(minLength: AceTheme.Spacing.sm)
                        if model.canOperate {
                            Button("Remove", role: .destructive) { removing = folder }
                                .buttonStyle(.borderless).foregroundStyle(AceTheme.Status.failed)
                                .accessibilityIdentifier("folders.remove.\(folder.name)")
                        }
                    }
                }
                if !loaded, problem == nil { ProgressView().frame(maxWidth: .infinity) }
            } header: { InsetHeader("Allowed folders") } footer: { Text("ace opens and creates projects only inside these folders on this machine.") }
            .insetRowBackground()
            if model.canOperate {
                Section {
                    TextField("Folder path, such as ~/code", text: $typed)
                        .aceMonospace(AceTheme.Typography.caption, relativeTo: .body)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .submitLabel(.done).onSubmit { Task { await allow(create: false) } }
                        .accessibilityIdentifier("folders.path")
                    if let missing, missing.typed == typed {
                        Button("Create \(missing.name) and add") { Task { await allow(create: true) } }
                            .accessibilityIdentifier("folders.create")
                    } else {
                        Button("Add folder") { Task { await allow(create: false) } }
                            .disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityIdentifier("folders.add")
                    }
                } header: { InsetHeader("Add a folder") } footer: {
                    if let missing, missing.typed == typed { Text("\(missing.path) doesn't exist yet on the machine.") }
                }
                .insetRowBackground()
            }
            if let problem { Section { ServiceProblem(message: problem) }.insetRowBackground() }
        }
        .insetGroupedList()
        .disabled(busy)
        .navigationTitle("Project folders").navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection) { await read() }
        .refreshable { await read() }
        .confirmationDialog("Stop allowing \(removing?.name ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { folder in
            Button("Remove", role: .destructive) { Task { await remove(folder) } }
        } message: { folder in Text("ace stops opening new projects in \(folder.path). Nothing on disk changes, and projects already added stay.") }
    }

    private func read() async {
        guard model.connection == "ready" else { return }
        do {
            folders = try await model.service(["type": "native.project", "request": ["op": "roots"]], as: FoldersReply.self).folders
            loaded = true; problem = nil
        } catch { problem = error.localizedDescription }
    }
    private func allow(create: Bool) async {
        let path = typed.trimmingCharacters(in: .whitespaces)
        guard !path.isEmpty else { return }
        busy = true; problem = nil
        defer { busy = false }
        let target = create ? (missing?.path ?? path) : path
        guard let reply = try? await model.service(["type": "native.project", "request": ["op": "allowFolder", "path": target, "create": create]], as: AllowReply.self) else {
            problem = "Couldn't reach the machine. Try again."; return
        }
        if reply.ok { typed = ""; missing = nil; await read() }
        else if reply.canCreate == true, let resolved = reply.path { missing = (path, resolved, reply.name ?? resolved) }
        else { problem = reply.message }
    }
    private func remove(_ folder: FoldersReply.Folder) async {
        busy = true
        defer { busy = false }
        let reply = await model.projectWrite(["op": "removeFolder", "path": folder.path])
        if !reply.ok { problem = reply.message }
        await read()
    }
}
