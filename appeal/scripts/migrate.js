
const { openDatabase } = require("../src/db");

const db = openDatabase();
db.close();
console.log("申诉库迁移完成");
