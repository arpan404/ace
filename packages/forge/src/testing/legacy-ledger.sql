CREATE TABLE forge_intents(thread_id TEXT NOT NULL,key TEXT NOT NULL,payload TEXT, pr_key TEXT,PRIMARY KEY(thread_id,key));
INSERT INTO forge_intents VALUES ('upgrade','forge:5182cd66016cd28ef7b4f1286499e1ccca7d05077e1df95498ae687cb444de0b:ci:f4f9274aeb9094ef1b9a1bb3e2f14269a0187d49aafd1208adb615571551f7e1',NULL,NULL);
INSERT INTO forge_intents VALUES ('upgrade','forge:5182cd66016cd28ef7b4f1286499e1ccca7d05077e1df95498ae687cb444de0b:comment:inline:13:48292f9b86d5cca5501054de226fbe0e59f9314abd4d6dfa0395abc14b0024fb',NULL,NULL);
CREATE TABLE forge_link_epochs(thread_id TEXT PRIMARY KEY, generation INTEGER NOT NULL);
INSERT INTO forge_link_epochs VALUES ('upgrade',1);
CREATE TABLE forge_links (thread_id TEXT NOT NULL, repo TEXT NOT NULL, number INTEGER NOT NULL, payload TEXT NOT NULL, generation INTEGER NOT NULL, summary TEXT, PRIMARY KEY(thread_id,repo,number));
INSERT INTO forge_links VALUES ('upgrade','{"forge":"github","host":"github.com","owner":"octo","name":"ace"}',7,'{"threadId":"upgrade","pr":{"repository":{"forge":"github","host":"github.com","owner":"octo","name":"ace"},"number":7}}',1,NULL);
