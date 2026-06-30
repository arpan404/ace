use crate::{
    actions::{
        AddCurrentDirectoryProject, ArchiveActiveThread, CommitReview,
        CreateTodoFromLatestTimelineItem, CreateWorktree, InterruptActiveTurn, NewThread,
        PinLatestTimelineItem, PushReview, Quit, RefreshActiveTab, RefreshApprovals, RefreshReview,
        RefreshWorktrees, RunLint, RunTests, SetActiveProjectDefaultModel, ShowBrowserTab,
        ShowPinnedTab, ShowPluginsTab, ShowProvidersTab, ShowSkillsTab, ShowTodosTab,
        StageReviewAll, ToggleBottomPanel, ToggleEnvironmentPanel,
        ToggleHighlightLatestTimelineItem, TogglePinActiveThread, ToggleRightPanel, ToggleSidebar,
        UnstageReviewAll,
    },
    backend::DesktopBackend,
    keyboard,
    ui::{assets::DesktopAssets, root::RootView, theme::Theme},
};
use gpui::{
    App, AppContext, Application, Bounds, Menu, MenuItem, Point, SystemMenuType, TitlebarOptions,
    WindowBounds, WindowOptions, px, size,
};

pub fn run() {
    let _logger = ace_logger::init_logger().expect("failed to initialize ace logger");
    let backend = match DesktopBackend::connect_or_spawn() {
        Ok(backend) => {
            match backend.check_status() {
                Ok(status) => tracing::info!(
                    ok = status.ok,
                    protocol_version = status.protocol_version,
                    launch_mode = ?backend.launch_mode(),
                    "connected to ace backend"
                ),
                Err(error) => tracing::warn!(%error, "ace backend status check failed"),
            }
            Some(backend)
        }
        Err(error) => {
            tracing::warn!(%error, "failed to start or connect to ace backend");
            None
        }
    };

    Application::new()
        .with_assets(DesktopAssets)
        .run(move |cx: &mut App| {
            gpui_component::init(cx);
            register_actions(cx);
            cx.bind_keys(keyboard::app_key_bindings());
            cx.set_menus(app_menus());

            let backend = backend;
            cx.open_window(window_options(cx), move |window, cx| {
                cx.activate(false);
                cx.new(|cx| RootView::new(window, cx, backend))
            })
            .expect("failed to open Ace desktop window");

            if should_activate_on_startup() {
                cx.activate(true);
            }
        });
}

fn should_activate_on_startup() -> bool {
    startup_activation_enabled(std::env::var("ACE_NO_STARTUP_ACTIVATE").as_deref().ok())
}

fn startup_activation_enabled(value: Option<&str>) -> bool {
    !matches!(value, Some("1" | "true"))
}

fn register_actions(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| cx.quit());
    cx.on_window_closed(|cx| {
        if cx.windows().is_empty() {
            cx.quit();
        }
    })
    .detach();
}

fn app_menus() -> Vec<Menu> {
    vec![
        Menu {
            name: Theme::app_name(),
            items: vec![
                MenuItem::os_submenu("Services", SystemMenuType::Services),
                MenuItem::separator(),
                MenuItem::action("New Chat", NewThread),
                MenuItem::action("Add Current Directory Project", AddCurrentDirectoryProject),
                MenuItem::separator(),
                MenuItem::action("Quit Ace", Quit),
            ],
        },
        Menu {
            name: "View".into(),
            items: vec![
                MenuItem::action("Search Commands", crate::actions::OpenSearchPalette),
                MenuItem::action("Refresh Active Tab", RefreshActiveTab),
                MenuItem::separator(),
                MenuItem::action("Toggle Sidebar", ToggleSidebar),
                MenuItem::action("Toggle Environment", ToggleEnvironmentPanel),
                MenuItem::action("Toggle Bottom Panel", ToggleBottomPanel),
                MenuItem::action("Toggle Right Panel", ToggleRightPanel),
                MenuItem::separator(),
                MenuItem::action("Show Browser", ShowBrowserTab),
                MenuItem::action("Show Pinned", ShowPinnedTab),
                MenuItem::action("Show Todos", ShowTodosTab),
                MenuItem::action("Show Providers", ShowProvidersTab),
                MenuItem::action("Show Plugins", ShowPluginsTab),
                MenuItem::action("Show Skills", ShowSkillsTab),
            ],
        },
        Menu {
            name: "Thread".into(),
            items: vec![
                MenuItem::action("Interrupt Active Turn", InterruptActiveTurn),
                MenuItem::action("Pin Active Thread", TogglePinActiveThread),
                MenuItem::action("Archive Active Thread", ArchiveActiveThread),
                MenuItem::separator(),
                MenuItem::action("Pin Latest Timeline Item", PinLatestTimelineItem),
                MenuItem::action(
                    "Highlight Latest Timeline Item",
                    ToggleHighlightLatestTimelineItem,
                ),
                MenuItem::action(
                    "Create Todo From Latest Item",
                    CreateTodoFromLatestTimelineItem,
                ),
                MenuItem::separator(),
                MenuItem::action("Set Project Default Model", SetActiveProjectDefaultModel),
            ],
        },
        Menu {
            name: "Review".into(),
            items: vec![
                MenuItem::action("Refresh Review", RefreshReview),
                MenuItem::action("Stage All", StageReviewAll),
                MenuItem::action("Unstage All", UnstageReviewAll),
                MenuItem::action("Commit Review", CommitReview),
                MenuItem::action("Push Review", PushReview),
                MenuItem::separator(),
                MenuItem::action("Refresh Worktrees", RefreshWorktrees),
                MenuItem::action("Create Worktree", CreateWorktree),
                MenuItem::separator(),
                MenuItem::action("Run Tests", RunTests),
                MenuItem::action("Run Lint", RunLint),
            ],
        },
        Menu {
            name: "Approvals".into(),
            items: vec![MenuItem::action("Refresh Approvals", RefreshApprovals)],
        },
    ]
}

fn window_options(cx: &App) -> WindowOptions {
    WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            Theme::default_window_size(),
            cx,
        ))),
        window_min_size: Some(size(px(980.0), px(640.0))),
        titlebar: Some(titlebar_options()),
        focus: should_activate_on_startup(),
        app_id: Some("dev.ace.desktop".to_string()),
        ..Default::default()
    }
}

fn titlebar_options() -> TitlebarOptions {
    TitlebarOptions {
        title: Some(Theme::app_name()),
        appears_transparent: true,
        traffic_light_position: Some(Point {
            x: px(16.0),
            y: px(16.0),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menus_keep_quit_action_available() {
        let menus = app_menus();
        assert_eq!(menus.len(), 5);
        assert_eq!(menus[0].name.as_ref(), "Ace");
        assert!(menu_has_action(&menus, "Ace", "Quit Ace"));
        assert!(menu_has_action(&menus, "Ace", "New Chat"));
        assert!(menu_has_action(
            &menus,
            "Ace",
            "Add Current Directory Project"
        ));
        assert!(menu_has_action(&menus, "View", "Toggle Sidebar"));
        assert!(menu_has_action(&menus, "View", "Show Browser"));
        assert!(menu_has_action(&menus, "View", "Show Providers"));
        assert!(menu_has_action(&menus, "Thread", "Archive Active Thread"));
        assert!(menu_has_action(
            &menus,
            "Thread",
            "Pin Latest Timeline Item"
        ));
        assert!(menu_has_action(&menus, "Review", "Refresh Review"));
        assert!(menu_has_action(&menus, "Review", "Create Worktree"));
        assert!(menu_has_action(&menus, "Approvals", "Refresh Approvals"));
    }

    fn menu_has_action(menus: &[Menu], menu_name: &str, action_name: &str) -> bool {
        menus
            .iter()
            .find(|menu| menu.name.as_ref() == menu_name)
            .is_some_and(|menu| {
                menu.items.iter().any(|item| {
                    matches!(item, MenuItem::Action { name, .. } if name.as_ref() == action_name)
                })
            })
    }

    #[test]
    fn startup_activation_can_be_disabled_for_watch_restarts() {
        assert!(!startup_activation_enabled(Some("1")));
        assert!(!startup_activation_enabled(Some("true")));
        assert!(startup_activation_enabled(None));
    }

    #[test]
    fn window_options_keep_native_titlebar_controls() {
        let titlebar = titlebar_options();

        assert_eq!(
            titlebar.title.as_ref().map(|title| title.as_ref()),
            Some("Ace")
        );
        assert!(titlebar.appears_transparent);
        assert_eq!(
            titlebar.traffic_light_position,
            Some(Point {
                x: px(16.0),
                y: px(16.0)
            })
        );
    }
}
