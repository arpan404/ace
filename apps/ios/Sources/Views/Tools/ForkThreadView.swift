import SwiftUI

struct ForkThreadView: View {
    let model: ClientModel
    let thread: ThreadModel
    let openThread: (String) -> Void
    @State private var point = ""
    @State private var text = ""
    @State private var saving = false
    @State private var saved = false
    private var points: [TranscriptRow] { thread.order.compactMap { thread.items[$0]?.row }.filter { $0.type == "message" && $0.complete } }
    var body: some View {
        Form {
            Section {
                Picker("Branch after", selection: $point) {
                    ForEach(points) { row in Text("\(row.role.capitalized): \(row.text.prefix(80))").tag(row.id) }
                }
                TextField("Continue this branch with…", text: $text, axis: .vertical).lineLimit(4...8)
                Button(saved ? "Branch saved" : "Create branch", systemImage: "arrow.triangle.branch") {
                    saving = true
                    Task { saved = await model.forkThread(point: point, text: text); saving = false }
                }.disabled(point.isEmpty || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || saving || saved || !model.canOperate)
            } footer: { Text("The new conversation keeps the source up to this message. Provider-private state may not carry over. Saved branches appear in the inbox after your machine accepts them.") }
            if let error = model.error { ServiceProblem(message: error) }
        }
        .navigationTitle("Branch conversation").navigationBarTitleDisplayMode(.inline)
        .onAppear { point = points.last?.id ?? "" }
    }
}
