import SwiftUI

/// A file's upload, drawn as a thin line along its chip's bottom edge: blue and filling with the
/// bytes the machine has (a short moving line until the first part lands), red when it failed.
/// When the upload finishes the line stays full while `finishing`, then fades.
struct UploadLine: View {
    let state: String
    let progress: Double
    /// The upload just finished (`uploadFinishing`): the full line shows a moment before it fades.
    var finishing = false
    @Environment(\.aceReduceMotion) private var reduceMotion
    @State private var sweep = false

    var body: some View {
        GeometryReader { box in
            let width = box.size.width
            ZStack(alignment: .leading) {
                switch state {
                case "failed":
                    Rectangle().fill(AceTheme.RowStatus.failed)
                case "uploading" where progress > 0:
                    Rectangle().fill(AceTheme.RowStatus.working)
                        .scaleEffect(x: max(0.04, progress), anchor: .leading)
                        .animation(reduceMotion ? nil : .default, value: progress)
                case "uploading":
                    // Nothing known yet: a short line travels, or rests half-lit under Reduce Motion.
                    Rectangle().fill(AceTheme.RowStatus.working)
                        .frame(width: width / 3)
                        .offset(x: reduceMotion ? width / 3 : sweep ? width : -width / 3)
                        .opacity(reduceMotion ? 0.5 : 1)
                        .onAppear {
                            guard !reduceMotion else { return }
                            withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) { sweep = true }
                        }
                default:
                    Rectangle().fill(AceTheme.RowStatus.working).opacity(finishing ? 1 : 0)
                }
            }
            .frame(width: width, alignment: .leading)
        }
        .frame(height: AceDesign.Size.rail)
        .clipped()
        .accessibilityHidden(true)
    }
}

extension View {
    /// Sets `finishing` for a moment when an upload in `state` goes from uploading to ready, so
    /// its chip can show the full line and a check before they fade.
    func uploadFinishing(_ state: String, _ finishing: Binding<Bool>) -> some View {
        modifier(UploadFinishing(state: state, finishing: finishing))
    }
}

private struct UploadFinishing: ViewModifier {
    let state: String
    @Binding var finishing: Bool
    @Environment(\.aceReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.onChange(of: state) { old, new in
            guard old == "uploading", new == "ready" else { return }
            finishing = true
            Task {
                try? await Task.sleep(for: .milliseconds(700))
                withAnimation(reduceMotion ? nil : .default) { finishing = false }
            }
        }
    }
}
