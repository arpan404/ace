import SwiftUI

struct ApprovalCard: View {
    let approval: ApprovalRow
    let resolve: (ApprovalRow.Option) -> Void
    @State private var submitted = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "terminal").font(.body).foregroundStyle(.orange)
                    .frame(width: 32, height: 32).background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 3) {
                    Text(approval.title).font(.subheadline.weight(.semibold))
                    if !approval.description.isEmpty { Text(approval.description).font(.caption).foregroundStyle(.secondary) }
                }
            }
            if !approval.command.isEmpty {
                Text(approval.command).font(.footnote.monospaced()).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            }
            HStack(spacing: 7) {
                ForEach(approval.options.sorted { rank($0.kind) < rank($1.kind) }) { option in
                    Button {
                        submitted = true
                        resolve(option)
                    } label: {
                        Text(option.label).font(.subheadline.weight(.medium)).frame(maxWidth: .infinity).padding(.vertical, 11)
                            .foregroundStyle(option.kind == "allow_once" ? Color(.systemBackground) : Color.primary)
                            .background(option.kind == "allow_once" ? Color.primary : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                    }.buttonStyle(.plain).accessibilityIdentifier("approval.\(option.kind)")
                }
            }.disabled(submitted)
            if submitted { Label("Waiting for the daemon", systemImage: "clock").font(.caption).foregroundStyle(.secondary) }
        }
        .padding(15).background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(.separator.opacity(0.3), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.07), radius: 15, y: 5)
        .padding(.horizontal, 14).padding(.bottom, 8)
        .sensoryFeedback(.selection, trigger: submitted)
        .accessibilityIdentifier("approval.card")
    }
    private func rank(_ kind: String) -> Int { kind == "deny" ? 0 : kind == "allow_once" ? 2 : 1 }
}
