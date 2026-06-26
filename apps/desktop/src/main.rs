#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod actions;
mod app;
mod backend;
mod keyboard;
mod persistence;
mod stores;
mod ui;

fn main() {
    app::run();
}
