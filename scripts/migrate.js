
const fs = require("node:fs");
const path = require("node:path");
const { openDatabase } = require("../src/db");

const databasePath = process.env.DATABASE_PATH;
const db = openDatabase(databasePath);
db.close();
console.log(`数据库迁移完成：${databasePath || path.join(process.cwd(), "data", "app.sqlite3")}`);
