pub const APP_TITLE: &str = "ace";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellViewModel {
    pub title: String,
}

impl Default for ShellViewModel {
    fn default() -> Self {
        Self {
            title: APP_TITLE.to_owned(),
        }
    }
}
