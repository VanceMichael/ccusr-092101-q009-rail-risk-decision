"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

function migrate(database) {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
  );
  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version)
  );
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const version = path.basename(file, ".sql");
    if (applied.has(version)) continue;
    database.exec("BEGIN");
    try {
      database.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
      database.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(version);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

function openDatabase(databasePath) {
  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  migrate(database);
  return database;
}

module.exports = { openDatabase, migrate };
