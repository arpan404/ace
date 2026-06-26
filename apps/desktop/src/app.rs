use crate::{
    actions::{
        AddCurrentDirectoryProject, InterruptActiveTurn, NewThread, Quit, SendActiveComposer,
        ToggleSidebar,
    },
    ui::{assets::DesktopAssets, root::RootView, theme::Theme},
};
use gpui::{
    App, AppContext, Application, Bounds, KeyBinding, Menu, MenuItem, Point, SystemMenuType,
    TitlebarOptions, WindowBounds, WindowOptions, px, size,
};

pub fn run() {
    let _logger = ace_logger::init_logger().expect("failed to initialize ace logger");

    Application::new()
        .with_assets(DesktopAssets)
        .run(|cx: &mut App| {
            gpui_component::init(cx);
            register_actions(cx);
            cx.bind_keys([
                KeyBinding::new("cmd-b", ToggleSidebar, None),
                KeyBinding::new("cmd-n", NewThread, None),
                KeyBinding::new("cmd-enter", SendActiveComposer, None),
                KeyBinding::new("cmd-.", InterruptActiveTurn, None),
            ]);
            cx.set_menus(app_menus());

            cx.open_window(window_options(cx), |window, cx| {
                cx.activate(false);
                cx.new(|cx| RootView::new(window, cx))
            })
            .expect("failed to open Ace desktop window");

            cx.activate(true);
        });
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
    vec![Menu {
        name: Theme::app_name(),
        items: vec![
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action("New Chat", NewThread),
            MenuItem::action("Add Current Directory Project", AddCurrentDirectoryProject),
            MenuItem::action("Toggle Sidebar", ToggleSidebar),
            MenuItem::separator(),
            MenuItem::action("Quit Ace", Quit),
        ],
    }]
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
        assert_eq!(menus.len(), 1);
        assert_eq!(menus[0].name.as_ref(), "Ace");
        assert!(menus[0].items.iter().any(|item| {
            matches!(item, MenuItem::Action { name, .. } if name.as_ref() == "Quit Ace")
        }));
        assert!(menus[0].items.iter().any(|item| {
            matches!(item, MenuItem::Action { name, .. } if name.as_ref() == "Toggle Sidebar")
        }));
        assert!(menus[0].items.iter().any(
            |item| matches!(item, MenuItem::Action { name, .. } if name.as_ref() == "New Chat")
        ));
        assert!(menus[0].items.iter().any(
            |item| matches!(item, MenuItem::Action { name, .. } if name.as_ref() == "Add Current Directory Project")
        ));
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
