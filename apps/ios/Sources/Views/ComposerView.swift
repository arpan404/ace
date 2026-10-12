import SwiftUI

struct ComposerView: View {
    let state: String
    let modelName: String
    let canSteer: Bool
    let send: (String, String) -> Void
    let stop: () -> Void
    @State private var text = ""
    @State private var delivery = "queue"
    @State private var feedback = 0
    var body: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Steer or follow up…", text: $text, axis: .vertical)
                .font(.body).lineLimit(1...5).accessibilityIdentifier("composer.input")
            Menu {
                Button("Queue follow-up", systemImage: "text.line.last.and.arrowtriangle.forward") { delivery = "queue" }
                if canSteer { Button("Steer now", systemImage: "arrow.turn.up.right") { delivery = "steer" } }
            } label: {
                Text(modelName.isEmpty ? "\(delivery.capitalized)" : modelName)
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    .padding(.horizontal, 8).padding(.vertical, 5).background(.quaternary, in: Capsule())
            }.accessibilityLabel("Delivery: \(delivery). Model: \(modelName)")
            Button {
                feedback += 1
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { stop() }
                else { send(text, delivery); text = "" }
            } label: {
                Image(systemName: text.isEmpty && state == "working" ? "stop.fill" : "arrow.up")
                    .font(.body.weight(.semibold)).frame(width: 36, height: 36)
                    .foregroundStyle(Color(.systemBackground)).background(.primary, in: Circle())
            }
            .disabled(text.isEmpty && state != "working")
            .accessibilityLabel(text.isEmpty && state == "working" ? "Stop whole agent tree" : "Send message")
            .accessibilityIdentifier("composer.send")
        }
        .padding(.leading, 18).padding(.trailing, 8).padding(.vertical, 9)
        .floatingGlass()
        .sensoryFeedback(.impact(weight: .light), trigger: feedback)
        .padding(.horizontal, 14).padding(.bottom, 8)
    }
}
