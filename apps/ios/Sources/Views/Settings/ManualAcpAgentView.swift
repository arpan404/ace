import SwiftUI

private struct ManualAnswer: ManageAnswer {
    struct Manual: Decodable { let canAdd: Bool; let note: String? }
    let ok: Bool
    let problem: String?
    let manual: Manual?
}

/// The web's Add by command page for an agent the registry doesn't list: a name and the command
/// that starts it. The bridge says whether this daemon can add one; when it can't, the page says
/// so and Add stays off, exactly as on the web, so nothing is added that couldn't be used.
struct ManualAcpAgentView: View {
    let model: ClientModel
    @State private var name = ""
    @State private var command = ""
    @State private var manual: ManualAnswer.Manual?
    @State private var problem: String?
    var body: some View {
        Form {
            Group {
                Section {
                    TextField("Gemini CLI", text: $name).accessibilityLabel("Name")
                } header: { InsetHeader("Name") }
                Section {
                    TextField("gemini --experimental-acp", text: $command, axis: .vertical)
                        .lineLimit(1...4).monospaced()
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.asciiCapable)
                        .accessibilityLabel("Command")
                } header: { InsetHeader("Command") } footer: {
                    Text("For an agent the registry doesn't list. ace starts the command on the computer running ace and talks to it over the Agent Client Protocol. It uses the agent's own login.")
                }
                Section {
                    Button("Add agent") {}
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .disabled(manual?.canAdd != true || !model.canOperate)
                } footer: { if let note = manual?.note { Text(note).transition(.opacity) } }
                ServiceProblem(message: problem)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .animation(.smooth(duration: 0.2), value: manual?.note)
        .navigationTitle("Add by command").navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model) { await read() }
    }
    private func read() async {
        do {
            manual = try await model.manage(["type": "acp.manual"], as: ManualAnswer.self).manual
            problem = nil
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}
