import SwiftUI

/// The browser annotations on the next message, in one row above the words: each marker's
/// number with its comment, as the page's markers show them. Tap one for Show on page or
/// Remove; Clear takes them all off. They go with the message, after the person's words.
struct AnnotationChips: View {
    let items: [AnnotationChip]
    let remove: (String) -> Void
    let clear: () -> Void
    @Environment(\.openBrowser) private var openBrowser
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: AceTheme.Spacing.xs) {
                    ForEach(items) { item in
                        Menu {
                            if let openBrowser {
                                Button("Show on page", ace: .browsers) { openBrowser() }
                            }
                            Button("Remove", ace: .x, role: .destructive) { remove(item.id) }
                        } label: { chip(item) }
                        .accessibilityIdentifier("composer.annotation.\(item.number)")
                        .transition(.opacity)
                    }
                }
                .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: items)
            }
            if items.count > 1 {
                Button("Clear", action: clear)
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .tint(AceTheme.Colours.mutedForeground)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .accessibilityIdentifier("composer.annotations.clear")
            }
        }
        .sensoryFeedback(.selection, trigger: items.count)
    }

    private func chip(_ item: AnnotationChip) -> some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            Text("\(item.number)")
                .font(.system(size: 11, weight: .semibold, design: .rounded)).monospacedDigit()
                .foregroundStyle(AceTheme.Colours.background)
                .frame(width: 18, height: 18)
                .background(AceTheme.Colours.foreground, in: Circle())
            Text(item.comment.isEmpty ? item.label : item.comment)
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.foreground)
                .lineLimit(1)
                .frame(maxWidth: 180, alignment: .leading)
            if item.state == "uploading" {
                ProgressView().controlSize(.mini)
            } else if item.state == "failed" {
                Text("No image").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.StatusText.failed)
            }
        }
        .padding(.leading, AceTheme.Spacing.xs).padding(.trailing, AceTheme.Spacing.sm)
        .frame(minHeight: 30)
        .background(AceTheme.Colours.fill, in: AceShape.capsule)
        .frame(minHeight: AceTheme.Dimensions.touchTarget)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Annotation \(item.number): \(item.comment.isEmpty ? item.label : item.comment)")
    }
}
