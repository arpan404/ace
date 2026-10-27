import SwiftUI

private struct ManualCheck: ManageAnswer {
    let ok: Bool
    let problem: String?
    let field: String?
    let display: String?
}

/// An ACP agent the registry doesn't list: a name and the command that starts it. Adding shows
/// the exact command ace will run on the computer running ace, and asks before binding it.
struct ManualAcpAgentView: View {
    let model: ClientModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var command = ""
    @State private var check: ManualCheck?
    @State private var confirming = false
    @State private var problem: String?
    @State private var busy = false
    @State private var added = false
    var body: some View {
        Form {
            Group {
                Section {
                    TextField("Gemini CLI", text: $name).accessibilityLabel("Name")
                    if !name.isEmpty, check?.field == "name", let text = check?.problem { fieldProblem(text) }
                } header: { InsetHeader("Name") }
                Section {
                    TextField("/usr/local/bin/my-agent --acp", text: $command, axis: .vertical)
                        .lineLimit(1...4).monospaced()
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.asciiCapable)
                        .accessibilityLabel("Command")
                    if !command.isEmpty, check?.field == "command", let text = check?.problem { fieldProblem(text) }
                } header: { InsetHeader("Command") } footer: {
                    Text("ace starts this command on the computer running ace and talks to it over the Agent Client Protocol. The agent uses its own login.")
                }
                ServiceProblem(message: problem)
                Section {
                    Button(busy ? "Adding…" : "Add agent") { confirming = true }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .disabled(busy || check?.display == nil || !model.canOperate)
                }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .animation(.smooth(duration: 0.2), value: check?.problem)
        .navigationTitle("Add by command").navigationBarTitleDisplayMode(.inline)
        .task(id: [name, command]) {
            check = try? await model.manage(["type": "acp.manual.check", "name": name, "command": command], as: ManualCheck.self)
        }
        .confirmationDialog("Add \(name.trimmingCharacters(in: .whitespaces))?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Add agent") { Task { await add() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("ace will run this on the computer running ace whenever you start a thread with it:\n\(check?.display ?? "")")
        }
        .sensoryFeedback(.success, trigger: added)
    }
    private func fieldProblem(_ text: String) -> some View {
        Text(text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.StatusText.failed).transition(.opacity)
    }
    private func add() async {
        busy = true; problem = nil
        defer { busy = false }
        do {
            _ = try await model.manage(["type": "acp.manual.add", "name": name, "command": command], as: PlainAnswer.self)
            added = true
            model.refreshMachine()
            dismiss()
        } catch { problem = error.localizedDescription }
    }
}
