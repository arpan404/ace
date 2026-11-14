// SPDX-License-Identifier: Apache-2.0
mod allocation;
mod cpu;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    cpu::run(include_bytes!("data/still-1206x2622.jpg"))
}
