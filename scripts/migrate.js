
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const databasePath = process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const database = new DatabaseSync(databasePath);
database.exec(fs.readFileSync(path.join(process.cwd(), "migrations", "001_bootstrap.sql"), "utf8"));
database.close();
console.log(`数据库迁移完成：${databasePath}`);
