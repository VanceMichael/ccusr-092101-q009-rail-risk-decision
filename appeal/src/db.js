
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const SERVICE_ROOT = path.resolve(__dirname, "..");

function openDatabase(databasePath = process.env.APPEAL_DATABASE_PATH) {
  const resolved = databasePath || path.join(SERVICE_ROOT, "data", "appeal.sqlite3");
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => row.version),
  );
  const migrationsDir = path.join(SERVICE_ROOT, "migrations");
  for (const file of fs.readdirSync(migrationsDir).filter((n) => n.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    db.exec("BEGIN");
    try {
      db.exec(fs.readFileSync(path.join(migrationsDir, file), "utf8"));
      db.prepare("INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)").run(file);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  return db;
}

module.exports = { openDatabase, SERVICE_ROOT };
