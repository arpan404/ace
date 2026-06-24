use crate::{root::RootView, theme::Theme};
use gpui::{
    App, AppContext, Application, Bounds, Menu, MenuItem, SystemMenuType, WindowBounds,
    WindowOptions, actions, px, size,
};
use tracing_subscriber::{EnvFilter, fmt};

actions!(ace, [Quit]);

pub fn run() {
    init_tracing();

    Application::new().run(|cx: &mut App| {
        register_actions(cx);
        cx.set_menus(app_menus());

        cx.open_window(window_options(cx), |window, cx| {
            cx.activate(false);
            cx.new(|cx| RootView::new(window, cx))
        })
        .expect("failed to open Ace desktop window");

        cx.activate(true);
    });
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt().with_env_filter(filter).with_target(false).try_init();
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
        titlebar: None,
        app_id: Some("dev.ace.desktop".to_string()),
        ..Default::default()
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
    }
}
