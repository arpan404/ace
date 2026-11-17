-- The maintainers' lists (ADR 0168, ADR 0174 §6, §16): the signed withdrawn list, categories,
-- featured entries and collections. A few rows each.

CREATE TABLE categories (
  position INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL
);
CREATE TABLE featured (
  position INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL
);
-- `entries` is JSON `[{type, name}]`.
CREATE TABLE collections (
  position INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  line TEXT NOT NULL,
  entries TEXT NOT NULL
);

-- The signed withdrawn list, newest `issued` only. Each catalogue marks its versions by it and
-- records the list it applied in its own `applied_lists`.
CREATE TABLE withdrawn (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  issued INTEGER NOT NULL,
  signed TEXT NOT NULL
);
