const http = require("node:http");
const { URL } = require("node:url");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "books.db");
const db = new DatabaseSync(DB_FILE);

db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    price REAL NOT NULL CHECK(price >= 0)
  )
`);

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("INVALID_JSON")); }
    });
    req.on("error", reject);
  });
}

function positiveId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function validBook(body) {
  if (typeof body.title !== "string" || !body.title.trim())
    return "title is required and must be a non-empty string";
  if (typeof body.author !== "string" || !body.author.trim())
    return "author is required and must be a non-empty string";
  if (typeof body.price !== "number" || !Number.isFinite(body.price) || body.price < 0)
    return "price is required and must be a non-negative number";
  return null;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === "/books" && method === "GET") {
    const searchQ = url.searchParams.get("search_q") || "";
    const orderBy = url.searchParams.get("order_by") || "id";
    const order = (url.searchParams.get("order") || "ASC").toUpperCase();
    const limit = Number(url.searchParams.get("limit") || 10);
    const offset = Number(url.searchParams.get("offset") || 0);
    const minRaw = url.searchParams.get("min_price");
    const maxRaw = url.searchParams.get("max_price");
    if (!["id","title","author","price"].includes(orderBy))
      return send(res,400,{message:"order_by must be id, title, author, or price"});
    if (!["ASC","DESC"].includes(order))
      return send(res,400,{message:"order must be ASC or DESC"});
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return send(res,400,{message:"limit must be an integer between 1 and 100"});
    if (!Number.isInteger(offset) || offset < 0)
      return send(res,400,{message:"offset must be a non-negative integer"});
    const conditions=[], values=[];
    if (searchQ.trim()) { conditions.push("title LIKE ?"); values.push(`%${searchQ.trim()}%`); }
    if (minRaw !== null) {
      const min=Number(minRaw);
      if (!Number.isFinite(min)) return send(res,400,{message:"min_price must be a number"});
      conditions.push("price >= ?"); values.push(min);
    }
    if (maxRaw !== null) {
      const max=Number(maxRaw);
      if (!Number.isFinite(max)) return send(res,400,{message:"max_price must be a number"});
      conditions.push("price <= ?"); values.push(max);
    }
    if (minRaw !== null && maxRaw !== null && Number(minRaw)>Number(maxRaw))
      return send(res,400,{message:"min_price cannot be greater than max_price"});
    const where=conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    // Values use bound parameters. Sort identifiers/direction use allowlists.
    const statement=db.prepare(`SELECT id,title,author,price FROM books ${where}
      ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`);
    const books=statement.all(...values,limit,offset);
    return send(res,200,{message:"Books retrieved successfully",books});
  }

  const match=pathname.match(/^\/books\/([^/]+)$/);
  if (match && method === "GET") {
    const id=positiveId(match[1]);
    if (!id) return send(res,400,{message:"id must be a positive integer"});
    const book=db.prepare("SELECT id,title,author,price FROM books WHERE id = ?").get(id);
    if (!book) return send(res,404,{message:"Book not found"});
    return send(res,200,{message:"Book retrieved successfully",book});
  }

  if (pathname === "/books" && method === "POST") {
    let body;
    try { body=await readBody(req); }
    catch { return send(res,400,{message:"Invalid JSON body"}); }
    const error=validBook(body);
    if (error) return send(res,400,{message:error});
    const result=db.prepare("INSERT INTO books (title,author,price) VALUES (?,?,?)")
      .run(body.title.trim(),body.author.trim(),body.price);
    const book=db.prepare("SELECT id,title,author,price FROM books WHERE id = ?").get(Number(result.lastInsertRowid));
    return send(res,201,{message:"Book created successfully",book});
  }

  if (match && method === "PUT") {
    const id=positiveId(match[1]);
    if (!id) return send(res,400,{message:"id must be a positive integer"});
    let body;
    try { body=await readBody(req); }
    catch { return send(res,400,{message:"Invalid JSON body"}); }
    const error=validBook(body);
    if (error) return send(res,400,{message:error});
    const existing=db.prepare("SELECT id FROM books WHERE id = ?").get(id);
    if (!existing) return send(res,404,{message:"Book not found"});
    db.prepare("UPDATE books SET title=?,author=?,price=? WHERE id=?")
      .run(body.title.trim(),body.author.trim(),body.price,id);
    const book=db.prepare("SELECT id,title,author,price FROM books WHERE id = ?").get(id);
    return send(res,200,{message:"Book updated successfully",book});
  }

  if (match && method === "DELETE") {
    const id=positiveId(match[1]);
    if (!id) return send(res,400,{message:"id must be a positive integer"});
    const existing=db.prepare("SELECT id FROM books WHERE id = ?").get(id);
    if (!existing) return send(res,404,{message:"Book not found"});
    db.prepare("DELETE FROM books WHERE id = ?").run(id);
    return send(res,200,{message:"Book deleted successfully"});
  }

  return send(res,404,{message:"Route not found"});
}

const server=http.createServer((req,res)=>{
  handle(req,res).catch(error=>{
    console.error("Request failed:",error.message);
    send(res,500,{message:"Internal server error"});
  });
});
server.listen(PORT,"0.0.0.0",()=>console.log(`Books API running on port ${PORT}`));
