use crate::{
    stores::{
        BrowserActivityProjection, BrowserBridgeProjection, BrowserPreviewProjection,
        BrowserProjection,
    },
    ui::{components::*, theme::Theme},
};
use gpui::{AnyElement, IntoElement, div, prelude::*, px};
use gpui_component::{IconName, tooltip::Tooltip};

use super::{clamp_text, empty_panel_body, info_row, stable_id};

pub(super) fn browser_body(theme: Theme, browser: &BrowserProjection) -> AnyElement {
    let Some(bridge) = browser.bridge.as_ref() else {
        return empty_panel_body(
            theme,
            AceIconName::Browser,
            "Browser",
            "Browser bridge status has not been loaded from the host runtime.",
        );
    };

    div()
        .flex()
        .flex_col()
        .gap_3()
        .child(info_row(theme, "Bridge", bridge_status_label(bridge)))
        .when_some(bridge.descriptor_name.as_deref(), |this, descriptor| {
            this.child(info_row(theme, "Descriptor", descriptor))
        })
        .child(info_row(theme, "Aliases", &join_or_empty(&bridge.aliases)))
        .child(info_row(
            theme,
            "Actions",
            &bridge.actions.len().to_string(),
        ))
        .child(browser_control_grid(theme, bridge))
        .child(browser_action_list(theme, bridge))
        .child(browser_preview_list(theme, &browser.previews))
        .child(browser_activity_list(theme, &browser.activities))
        .when_some(browser.error.as_deref(), |this, error| {
            this.child(
                div()
                    .rounded_md()
                    .border_1()
                    .border_color(theme.accent_danger.opacity(0.45))
                    .bg(theme.panel)
                    .px_2()
                    .py_2()
                    .text_size(px(12.0))
                    .text_color(theme.accent_danger)
                    .child(error.to_string()),
            )
        })
        .when(
            browser.activities.is_empty() && browser.previews.is_empty(),
            |this| {
                this.child(
                    div()
                        .rounded_md()
                        .border_1()
                        .border_color(theme.border_subtle)
                        .bg(theme.panel)
                        .px_2()
                        .py_2()
                        .text_size(px(12.0))
                        .line_height(px(17.0))
                        .text_color(theme.muted)
                        .child(browser_empty_frame_notice(bridge)),
                )
            },
        )
        .into_any_element()
}

fn browser_empty_frame_notice(bridge: &BrowserBridgeProjection) -> &'static str {
    match bridge.status.as_str() {
        "connected" => {
            "Browser bridge is connected, but no viewport frames or preview artifacts are attached to this thread. Use provider browser tools to navigate or capture a viewport before frame output is shown."
        }
        "missing" => {
            "Browser bridge is missing from the host runtime. Attach a browser-capable host tool bridge before browser frames or input controls can run."
        }
        "unavailable" => {
            "Browser bridge is registered but unavailable on this host. Check host runtime capabilities before requesting browser navigation or frame capture."
        }
        _ => {
            "Browser bridge status is unknown. Refresh the provider runtime before requesting browser navigation or frame capture."
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct BrowserControlSpec {
    label: &'static str,
    detail: &'static str,
    actions: &'static [&'static str],
}

fn browser_control_specs() -> &'static [BrowserControlSpec] {
    &[
        BrowserControlSpec {
            label: "URL",
            detail: "Open localhost, file previews, and public pages.",
            actions: &["browser.navigate"],
        },
        BrowserControlSpec {
            label: "Input",
            detail: "Forward click, type, scroll, and keyboard events.",
            actions: &[
                "browser.click",
                "browser.type",
                "browser.scroll",
                "browser.key",
            ],
        },
        BrowserControlSpec {
            label: "Screenshot",
            detail: "Capture a viewport frame from the host browser service.",
            actions: &["browser.screenshot"],
        },
        BrowserControlSpec {
            label: "Inspect",
            detail: "Read DOM snapshots or inspect rendered state with approval.",
            actions: &["browser.inspect"],
        },
        BrowserControlSpec {
            label: "Logs",
            detail: "Read console and network-style browser activity.",
            actions: &["browser.logs", "browser.console"],
        },
        BrowserControlSpec {
            label: "Viewport",
            detail: "Resize, zoom, or switch browser viewport/tab state.",
            actions: &["browser.viewport", "browser.zoom", "browser.tab"],
        },
    ]
}

fn browser_control_supported(bridge: &BrowserBridgeProjection, spec: BrowserControlSpec) -> bool {
    spec.actions
        .iter()
        .any(|action| bridge.actions.iter().any(|available| available == action))
}

fn browser_control_grid(theme: Theme, bridge: &BrowserBridgeProjection) -> AnyElement {
    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .p_2()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .text_size(px(11.0))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted)
                .child("Browser controls"),
        )
        .child(
            div().grid().grid_cols(2).gap_2().children(
                browser_control_specs()
                    .iter()
                    .map(|spec| browser_control_chip(theme, bridge, *spec))
                    .collect::<Vec<_>>(),
            ),
        )
        .into_any_element()
}

fn browser_control_icon(spec: BrowserControlSpec) -> IconName {
    match spec.label {
        "URL" | "Viewport" => IconName::Globe,
        "Input" => IconName::SquareTerminal,
        "Screenshot" => IconName::File,
        "Inspect" | "Logs" => IconName::Info,
        _ => IconName::Check,
    }
}

fn browser_control_chip(
    theme: Theme,
    bridge: &BrowserBridgeProjection,
    spec: BrowserControlSpec,
) -> AnyElement {
    let supported = browser_control_supported(bridge, spec);
    let color = if supported {
        theme.foreground.opacity(0.82)
    } else {
        theme.muted_subtle.opacity(0.64)
    };
    let icon_color = if supported {
        theme.accent_success
    } else {
        theme.muted_subtle.opacity(0.64)
    };
    let tooltip = if supported {
        spec.detail.to_string()
    } else {
        format!(
            "{} Missing bridge action: {}",
            spec.detail,
            spec.actions.join(" or ")
        )
    };

    div()
        .id(("browser-control", stable_id(spec.label)))
        .min_h(px(34.0))
        .rounded_md()
        .border_1()
        .border_color(if supported {
            theme.border_subtle
        } else {
            theme.border_subtle.opacity(0.48)
        })
        .bg(if supported {
            theme.panel_deep
        } else {
            theme.panel_deep.opacity(0.54)
        })
        .px_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_2()
        .text_size(px(12.0))
        .text_color(color)
        .child(icon_svg(browser_control_icon(spec), icon_color))
        .child(spec.label)
        .child(div().flex_1())
        .child(
            div()
                .text_size(px(10.0))
                .text_color(if supported {
                    theme.accent_success
                } else {
                    theme.muted_subtle
                })
                .child(if supported { "Ready" } else { "Missing" }),
        )
        .tooltip(move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx))
        .into_any_element()
}

fn browser_preview_list(theme: Theme, previews: &[BrowserPreviewProjection]) -> AnyElement {
    if previews.is_empty() {
        return div().into_any_element();
    }

    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .p_2()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .text_size(px(11.0))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted)
                .child("Viewport previews"),
        )
        .children(
            previews
                .iter()
                .map(|preview| browser_preview_card(theme, preview))
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn browser_preview_card(theme: Theme, preview: &BrowserPreviewProjection) -> AnyElement {
    div()
        .id(("browser-preview", stable_id(&preview.id)))
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .overflow_hidden()
        .flex()
        .flex_col()
        .child(
            div()
                .h(px(112.0))
                .border_b_1()
                .border_color(theme.border_subtle)
                .bg(theme.background)
                .flex()
                .items_center()
                .justify_center()
                .text_color(theme.muted)
                .child(ace_icon_svg(AceIconName::Browser, theme.accent_blue)),
        )
        .child(
            div()
                .p_2()
                .flex()
                .flex_col()
                .gap_1()
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(theme.foreground.opacity(0.84))
                        .child(clamp_text(&preview.title, 120)),
                )
                .child(
                    div()
                        .font_family(theme.code_font_family)
                        .text_size(px(11.0))
                        .text_color(theme.muted)
                        .child(clamp_text(&preview.location, 180)),
                )
                .child(
                    div()
                        .text_size(px(11.0))
                        .text_color(theme.muted_subtle)
                        .child(browser_preview_meta(preview)),
                ),
        )
        .tooltip({
            let detail = preview.detail.clone();
            move |window, cx| Tooltip::new(detail.clone()).build(window, cx)
        })
        .into_any_element()
}

fn browser_action_list(theme: Theme, bridge: &BrowserBridgeProjection) -> AnyElement {
    if bridge.actions.is_empty() {
        return div().into_any_element();
    }

    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .p_2()
        .flex()
        .flex_col()
        .gap_1()
        .child(
            div()
                .text_size(px(11.0))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted)
                .child("Supported browser actions"),
        )
        .children(
            bridge
                .actions
                .iter()
                .take(14)
                .map(|action| {
                    div()
                        .min_h(px(20.0))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .text_size(px(12.0))
                        .text_color(theme.foreground.opacity(0.78))
                        .child(icon_svg(IconName::Check, theme.accent_success))
                        .child(action.clone())
                })
                .collect::<Vec<_>>(),
        )
        .when(bridge.actions.len() > 14, |this| {
            this.child(
                div()
                    .pt_1()
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(format!("{} more actions", bridge.actions.len() - 14)),
            )
        })
        .into_any_element()
}

fn browser_activity_list(theme: Theme, activities: &[BrowserActivityProjection]) -> AnyElement {
    if activities.is_empty() {
        return div().into_any_element();
    }

    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel)
        .p_2()
        .flex()
        .flex_col()
        .gap_2()
        .child(
            div()
                .text_size(px(11.0))
                .font_weight(gpui::FontWeight::SEMIBOLD)
                .text_color(theme.muted)
                .child("Recent browser activity"),
        )
        .children(
            activities
                .iter()
                .rev()
                .take(8)
                .map(|activity| browser_activity_card(theme, activity))
                .collect::<Vec<_>>(),
        )
        .into_any_element()
}

fn browser_activity_card(theme: Theme, activity: &BrowserActivityProjection) -> AnyElement {
    div()
        .rounded_md()
        .border_1()
        .border_color(theme.border_subtle)
        .bg(theme.panel_deep)
        .p_2()
        .flex()
        .flex_col()
        .gap_1()
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .gap_2()
                .text_size(px(12.0))
                .text_color(theme.foreground.opacity(0.82))
                .child(icon_svg(IconName::Globe, theme.accent_blue))
                .child(clamp_text(&activity.title, 120)),
        )
        .child(
            div()
                .text_size(px(11.0))
                .line_height(px(16.0))
                .text_color(theme.muted)
                .child(clamp_text(&activity.detail, 180)),
        )
        .when_some(activity.target.as_deref(), |this, target| {
            this.child(
                div()
                    .font_family(theme.code_font_family)
                    .text_size(px(11.0))
                    .text_color(theme.muted_subtle)
                    .child(clamp_text(target, 160)),
            )
        })
        .child(
            div()
                .text_size(px(11.0))
                .text_color(theme.muted_subtle)
                .child(format!("{} · {}", activity.status, activity.observed_at)),
        )
        .into_any_element()
}

fn bridge_status_label(bridge: &BrowserBridgeProjection) -> &'static str {
    match bridge.status.as_str() {
        "connected" => "Connected",
        "unavailable" => "Unavailable",
        "missing" => "Missing",
        _ => "Unknown",
    }
}

fn join_or_empty(values: &[String]) -> String {
    if values.is_empty() {
        "None".to_string()
    } else {
        values.join(", ")
    }
}

fn browser_preview_meta(preview: &BrowserPreviewProjection) -> String {
    match preview.mime_type.as_deref() {
        Some(mime_type) => format!("{mime_type} · {}", preview.observed_at),
        None => preview.observed_at.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_controls_are_backed_by_bridge_actions() {
        let bridge = BrowserBridgeProjection {
            status: "connected".to_string(),
            descriptor_name: Some("browser.bridge".to_string()),
            aliases: vec!["ace_browser".to_string()],
            actions: vec![
                "browser.navigate".to_string(),
                "browser.screenshot".to_string(),
                "browser.viewport".to_string(),
                "browser.console".to_string(),
            ],
            capability_keys: Vec::new(),
        };

        let specs = browser_control_specs();
        let url = specs.iter().find(|spec| spec.label == "URL").unwrap();
        let screenshot = specs
            .iter()
            .find(|spec| spec.label == "Screenshot")
            .unwrap();
        let logs = specs.iter().find(|spec| spec.label == "Logs").unwrap();
        let input = specs.iter().find(|spec| spec.label == "Input").unwrap();

        assert!(browser_control_supported(&bridge, *url));
        assert!(browser_control_supported(&bridge, *screenshot));
        assert!(browser_control_supported(&bridge, *logs));
        assert!(!browser_control_supported(&bridge, *input));
    }

    #[test]
    fn browser_empty_frame_notice_reflects_bridge_status() {
        let bridge = |status: &str| BrowserBridgeProjection {
            status: status.to_string(),
            descriptor_name: None,
            aliases: Vec::new(),
            actions: Vec::new(),
            capability_keys: Vec::new(),
        };

        assert!(browser_empty_frame_notice(&bridge("connected")).contains("connected"));
        assert!(browser_empty_frame_notice(&bridge("connected")).contains("viewport frames"));
        assert!(browser_empty_frame_notice(&bridge("missing")).contains("missing"));
        assert!(browser_empty_frame_notice(&bridge("unavailable")).contains("unavailable"));
        assert!(browser_empty_frame_notice(&bridge("other")).contains("unknown"));
    }
}
