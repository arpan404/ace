import SwiftUI

/// Above the composer: the files on the next message with their upload progress, a + menu that
/// adds photos (library or camera) and files, and the effort and speed chip where the thread's
/// provider takes them. Every check (size, what the agent can read, which levels exist) is the
/// bridge's; this view stages the picked bytes and draws what the bridge says.
struct ComposerAccessories: View {
    @Bindable var model: ClientModel
    let screen: ThreadScreenModel
    @State private var problem: String?
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            if !screen.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: AceTheme.Spacing.xs) {
                        ForEach(screen.attachments) { file in AttachmentChip(file: file) { model.detach(file.id) } }
                    }
                }
            }
            HStack(spacing: AceTheme.Spacing.sm) {
                AttachMenu(stage: { model.attach($0) }, problem: $problem)
                if let tune = screen.tune, !tune.efforts.isEmpty || !tune.speeds.isEmpty { TuneChip(tune: tune, model: model) }
                if let notice = screen.tune?.notice, !notice.isEmpty {
                    Text(notice).lineLimit(1).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                if let problem { Text(problem).lineLimit(2).foregroundStyle(AceTheme.StatusText.failed) }
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
        }
        .padding(.horizontal, AceTheme.Dimensions.composerInset + AceTheme.Spacing.xs)
    }
}

/// "High · Fast": the next message's effort and speed, with why one can't change.
private struct TuneChip: View {
    let tune: TuneRow
    let model: ClientModel
    var body: some View {
        Menu {
            if !tune.efforts.isEmpty {
                Section(tune.effortReason.isEmpty ? "Effort" : "Effort · \(tune.effortReason)") {
                    ForEach(tune.efforts) { effort in
                        Button { Task { _ = await model.setEffort(effort.id) } } label: {
                            if effort.id == tune.effort { Label(effort.label, systemImage: "checkmark") } else { Text(effort.label) }
                        }.disabled(!tune.effortReason.isEmpty)
                    }
                    if tune.canReset { Button("Model default") { Task { _ = await model.setEffort(nil) } } }
                }
            }
            if !tune.speeds.isEmpty {
                Section(tune.speedReason.isEmpty ? "Speed" : "Speed · \(tune.speedReason)") {
                    ForEach(tune.speeds) { tier in
                        Button { Task { _ = await model.setSpeed(tier.speed) } } label: {
                            if tier.speed == tune.speed { Label(tier.label, systemImage: "checkmark") } else { Text(tier.label) }
                        }.disabled(!tune.speedReason.isEmpty)
                    }
                }
            }
        } label: {
            HStack(spacing: AceTheme.Spacing.xxs) {
                Image(systemName: tune.speed == "standard" ? "gauge.with.dots.needle.33percent" : "bolt.fill")
                Text(label).lineLimit(1)
                if tune.pending { Image(systemName: "clock") }
            }
            .padding(.horizontal, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.xs)
            .background(AceTheme.Colours.fill, in: Capsule())
            .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
        }
        .accessibilityLabel("Effort and speed: \(label)\(tune.pending ? ", applies with your next message" : "")")
        .accessibilityIdentifier("composer.tune")
    }
    private var label: String {
        let effort = tune.efforts.first { $0.id == tune.effort }?.label
        let speed = tune.speeds.first { $0.speed == tune.speed && tune.speed != "standard" }?.label
        return [effort, speed].compactMap { $0 }.joined(separator: " · ")
    }
}
