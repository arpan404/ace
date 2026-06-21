pub(crate) const PROJECT_SEARCH_ENTRIES_MAX_LIMIT: usize = 200;
pub(crate) const PROJECT_READ_FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;
pub(crate) const WORKSPACE_INDEX_MAX_ENTRIES: usize = 25_000;
pub(crate) const READ_FILE_CACHE_MAX_ENTRIES: usize = 128;

pub(crate) const FAVICON_CANDIDATES: &[&str] = &[
    "favicon.svg",
    "favicon.ico",
    "favicon.png",
    "public/favicon.svg",
    "public/favicon.ico",
    "public/favicon.png",
    "app/favicon.ico",
    "app/favicon.png",
    "app/icon.svg",
    "app/icon.png",
    "app/icon.ico",
    "src/favicon.ico",
    "src/favicon.svg",
    "src/app/favicon.ico",
    "src/app/icon.svg",
    "src/app/icon.png",
    "assets/icon.svg",
    "assets/icon.png",
    "assets/logo.svg",
    "assets/logo.png",
];

pub(crate) const ICON_SOURCE_FILES: &[&str] = &[
    "index.html",
    "public/index.html",
    "app/routes/__root.tsx",
    "src/routes/__root.tsx",
    "app/root.tsx",
    "src/root.tsx",
    "src/index.html",
];

pub(crate) const IGNORED_DIRECTORY_NAMES: &[&str] = &[
    ".git",
    ".convex",
    "node_modules",
    ".turbo",
    "dist",
    "build",
    "out",
    ".cache",
];
pub(crate) const IGNORED_FILE_NAMES: &[&str] = &[".DS_Store", "Thumbs.db", "Desktop.ini"];
