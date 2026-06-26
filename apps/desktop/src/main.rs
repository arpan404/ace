#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod actions;
mod app;
mod persistence;
mod stores;
mod ui;

fn main() {
    app::run();
}
