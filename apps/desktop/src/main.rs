#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod layout;
mod root;
mod theme;

fn main() {
    app::run();
}
