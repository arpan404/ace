import QuickLook
import SwiftUI

/// One of the bot's files (web's `file-editor.tsx` over `spade-file-port.ts`). A text file opens
/// to edit in the phone's source editor; Save names the revision it opened, and when the bot
/// changed the file meanwhile Spade refuses it and the person chooses: keep theirs (saved over
/// the bot's) or take the bot's. While the computer changes hands, Save says why it can't. Any
/// other file opens in the phone's viewer.
struct SpadeComputerFileEditor: View {
    let model: ClientModel
    let watch: SpadeComputerWatch
    let path: String
    let name: String
    let face: SpadeModel.Face
    @State private var file: SpadeFile?
    @State private var problem: String?
    /// The revision the text on screen began from: a save sends it back.
    @State private var revision: String?
    /// Bumps when other text loads over the editor's, so the view takes it.
    @State private var loads = 0
    @State private var dirty = false
    @State private var saving = false
    @State private var clashed = false
    @State private var alert: String?
    @State private var preview: URL?
    @State private var opening = false
    @State private var handle = SourceHandle()

    private var fileName: String { path.split(separator: "/").last.map(String.init) ?? path }
    private var mayAct: Bool { watch.mayAct(model) }

    var body: some View {
        content
            .navigationTitle(fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if file?.text != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "Saving…" : "Save") { Task { await save(over: revision) } }
                            .disabled(!dirty || saving)
                            .accessibilityIdentifier("spade.file.save")
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                SpadeDriveLineView(model: model, watch: watch, kind: "files", face: face)
                    .padding(.horizontal, AceDesign.Space.margin)
                    .padding(.vertical, AceDesign.Space.related)
                    .background(AceDesign.Surface.background)
            }
            .task { if file == nil { await load() } }
            .followsComputer(watch, model: model)
            .quickLookPreview($preview)
            .confirmationDialog("\(name) changed \(fileName) since you opened it", isPresented: $clashed, titleVisibility: .visible) {
                Button("Keep mine") { Task { await keepMine() } }
                Button("Take \(name)'s") { Task { await load() } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Keep mine saves your text over \(name)'s change. Take \(name)'s drops your edits.") }
            .alert(alert ?? "", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
                Button("Close", role: .cancel) { alert = nil }
            }
    }

    @ViewBuilder private var content: some View {
        if let file, let text = file.text {
            SourceTextView(document: SourceDocument(key: "\(path)|\(loads)", text: text, language: nil, marks: [:]),
                           wrap: true, editable: mayAct, line: nil, handle: handle, dirty: { dirty = $0 })
                .accessibilityIdentifier("spade.file.text")
        } else if let file {
            EmptyState(icon: .file, title: fileName,
                       line: file.unreadable == "too_large" ? "Too large to edit on the phone." : "This file isn't text.") {
                Button(opening ? "Opening…" : "Open") { Task { await view() } }
                    .buttonStyle(.primaryAction)
                    .disabled(opening)
            }
        } else if let problem {
            List { ProblemRow(problem, id: "spade.file.problem") { Task { await load() } } }
        } else {
            List { SkeletonRows(count: 6).listRowInsets(EdgeInsets()) }
        }
    }

    /// Reads the file: Take the bot's drops what was typed.
    private func load() async {
        let reply = await model.spadeComputer(["type": "spade.files.file", "agentId": watch.agent, "path": path],
                                              failing: "Couldn't open the file")
        guard let read = reply.file else { problem = reply.problem; return }
        problem = nil
        file = read
        revision = read.revision
        dirty = false
        loads += 1
        // Not text: it opens in the viewer at once.
        if read.text == nil, preview == nil { await view() }
    }

    private func save(over base: String?) async {
        // Checked right before it goes: the person may have handed back meanwhile.
        guard mayAct else { alert = spadeNotNowToChange; return }
        saving = true
        defer { saving = false }
        var payload: [String: Any] = ["type": "spade.files.save", "agentId": watch.agent, "path": path, "text": handle.text]
        if let base { payload["base"] = base }
        let reply = await model.spadeComputer(payload, failing: "Couldn't save \(fileName)", timeout: .seconds(120))
        if reply.ok {
            dirty = false
            // Unknown when the bot wrote again right after: a revision no file has, so the next
            // save is refused and asks rather than writing over the bot's.
            revision = reply.revision ?? "unconfirmed-\(UUID().uuidString)"
        } else if reply.changed == true {
            clashed = true
        } else {
            alert = reply.problem
        }
    }

    /// Keep mine: saved over the revision of the bot's change, read now.
    private func keepMine() async {
        let reply = await model.spadeComputer(["type": "spade.files.revision", "agentId": watch.agent, "path": path],
                                              failing: "Couldn't check the file. Try again.")
        guard reply.ok else { alert = reply.problem; return }
        await save(over: reply.revision)
    }

    private func view() async {
        opening = true
        defer { opening = false }
        do { preview = try await model.spadeDownload(watch.agent, path: path) }
        catch { alert = "\(fileName) couldn't be read. Check the connection and try again." }
    }
}
