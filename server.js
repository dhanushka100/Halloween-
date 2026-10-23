const express = require("express");
const { DatabaseSync } = require("node:sqlite"); // built into Node 22.5+, nothing to compile
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SALT = process.env.IP_SALT || "change-this-salt";
const ENTRY_END = new Date(process.env.ENTRY_END || "2026-11-01T03:59:00Z"); // Oct 31, 11:59 PM EDT
const VOTE_END = new Date(process.env.VOTE_END || "2026-11-02T04:59:00Z");   // Nov 1, 11:59 PM EST
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const CATS = ["Best Pet Costume", "Best Costume", "Best Decoration"];

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, "contest.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS entries(
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, category TEXT, link TEXT,
  caption TEXT, img TEXT, news INTEGER DEFAULT 0, status TEXT DEFAULT 'pending',
  created TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(email, category));
CREATE TABLE IF NOT EXISTS votes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id INTEGER, category TEXT, voter TEXT, ip TEXT,
  created TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(category, voter), UNIQUE(category, ip));
`);

const app = express();
app.set("trust proxy", 1); // needed behind Render/Railway/Nginx so req.ip is the real visitor IP
// photo uploads arrive as a small compressed JPEG (data URL) from the browser, so /api/entries gets a bigger limit
app.use((req, res, next) => express.json({ limit: req.path === "/api/entries" ? "1mb" : "20kb" })(req, res, next));

function cookies(req) {
  const o = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}
function voterId(req, res) {
  let c = cookies(req).vid;
  if (!/^[a-f0-9]{32}$/.test(c || "")) {
    c = crypto.randomBytes(16).toString("hex");
    res.cookie("vid", c, { maxAge: 90 * 864e5, httpOnly: true, sameSite: "lax" });
  }
  return c;
}
const ipHash = req => crypto.createHash("sha256").update(SALT + req.ip).digest("hex").slice(0, 32);
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

const entryLimiter = rateLimit({ windowMs: 3600e3, max: 10, message: { error: "Too many entries. Try again later." } });
const voteLimiter = rateLimit({ windowMs: 3600e3, max: 30, message: { error: "Too many votes. Try again later." } });

// ---- Public API ----
app.post("/api/entries", entryLimiter, (req, res) => {
  const b = req.body || {};
  if (b._gotcha) return res.json({ ok: true }); // bot honeypot: pretend success
  if (new Date() > ENTRY_END) return res.status(403).json({ error: "Entries are closed." });
  const name = str(b.name, 60), email = str(b.email, 120).toLowerCase();
  const link = str(b.link, 500), caption = str(b.caption, 140), category = str(b.category, 40);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Please enter a valid name and email." });
  if (!CATS.includes(category)) return res.status(400).json({ error: "Please choose a category." });
  const hasLink = /^https?:\/\//i.test(link);
  if (link && !hasLink) return res.status(400).json({ error: "Please enter a valid link starting with https://" });
  let file = null;
  if (b.photo) {
    const prefix = "data:image/jpeg;base64,";
    const str64 = String(b.photo);
    if (!str64.startsWith(prefix)) return res.status(400).json({ error: "Invalid photo." });
    const buf = Buffer.from(str64.slice(prefix.length), "base64");
    if (buf.length > 1.5e6 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return res.status(400).json({ error: "Invalid photo." });
    file = crypto.randomBytes(12).toString("hex") + ".jpg";
    fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  }
  if (!hasLink && !file) return res.status(400).json({ error: "Please upload a photo or add a link." });
  if (!(b.eligible && b.rights && b.rules)) return res.status(400).json({ error: "Please tick all required boxes." });
  try {
    db.prepare("INSERT INTO entries(name,email,category,link,caption,img,news) VALUES(?,?,?,?,?,?,?)")
      .run(name, email, category, link, caption, file ? "/uploads/" + file : null, b.news ? 1 : 0);
    res.json({ ok: true });
  } catch (e) {
    if (file) fs.unlink(path.join(UPLOAD_DIR, file), () => {});
    res.status(409).json({ error: "You already entered this category with this email." });
  }
});

app.get("/api/entries", (req, res) => {
  const vid = voterId(req, res);
  const rows = db.prepare(`
    SELECT e.id, e.name, e.category AS cat, e.caption, e.img, e.link,
           (SELECT COUNT(*) FROM votes v WHERE v.entry_id = e.id) AS votes
    FROM entries e WHERE e.status = 'approved' ORDER BY votes DESC, e.id`).all();
  const mine = {};
  db.prepare("SELECT category, entry_id FROM votes WHERE voter = ? OR ip = ?").all(vid, ipHash(req))
    .forEach(v => { mine[v.category] = v.entry_id; });
  res.json({ entries: rows.map(r => ({ ...r, name: r.name.split(" ")[0] })), mine });
});

app.post("/api/vote", voteLimiter, (req, res) => {
  if (new Date() > VOTE_END) return res.status(403).json({ error: "Voting has ended." });
  const e = db.prepare("SELECT id, category FROM entries WHERE id = ? AND status = 'approved'").get(Number((req.body || {}).id));
  if (!e) return res.status(404).json({ error: "Entry not found." });
  try {
    db.prepare("INSERT INTO votes(entry_id,category,voter,ip) VALUES(?,?,?,?)").run(e.id, e.category, voterId(req, res), ipHash(req));
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: "You already voted in this category." });
  }
});

// ---- Admin (HTTP Basic auth, password from ADMIN_PASSWORD) ----
function admin(req, res, next) {
  if (!ADMIN_PASSWORD) return res.status(503).send("Set the ADMIN_PASSWORD environment variable to enable the admin page.");
  const h = req.headers.authorization || "";
  if (h.startsWith("Basic ")) {
    const pw = Buffer.from(h.slice(6), "base64").toString().split(":").slice(1).join(":");
    const a = crypto.createHash("sha256").update(pw).digest();
    const b = crypto.createHash("sha256").update(ADMIN_PASSWORD).digest();
    if (crypto.timingSafeEqual(a, b)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="admin"').status(401).send("Login required");
}

app.get("/api/admin/entries", admin, (req, res) => {
  res.json(db.prepare(`
    SELECT e.*, (SELECT COUNT(*) FROM votes v WHERE v.entry_id = e.id) AS votes
    FROM entries e ORDER BY e.category, votes DESC, e.id`).all());
});
app.post("/api/admin/entries/:id", admin, (req, res) => {
  if (!req.is("json")) return res.status(415).end();
  const st = req.body.status;
  if (!["approved", "rejected", "pending"].includes(st)) return res.status(400).json({ error: "bad status" });
  const img = /^https?:\/\//i.test(req.body.img || "") ? String(req.body.img).slice(0, 500) : null;
  db.prepare("UPDATE entries SET status = ?, img = COALESCE(?, img) WHERE id = ?").run(st, img, Number(req.params.id));
  res.json({ ok: true });
});

const ADMIN_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Contest admin</title>
<style>body{font:15px system-ui;margin:20px;background:#111;color:#eee}table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:8px;text-align:left;vertical-align:top}
input{width:100%;background:#222;color:#eee;border:1px solid #444;padding:6px}button{padding:6px 12px;margin:2px;cursor:pointer}.s-approved{color:#7CFC8A}.s-rejected{color:#ff8a8a}a{color:#ffa94d}.t{overflow-x:auto}</style>
<h2>🎃 Contest admin</h2><p>Votes count only for approved entries. Paste a direct image URL (optional) to show a thumbnail in the gallery.</p>
<div class="t"><table><thead><tr><th>Category</th><th>Entry</th><th>Votes</th><th>Status</th><th>Image URL</th><th></th></tr></thead><tbody id="b"></tbody></table></div>
<script>
function el(t,x,p){var e=document.createElement(t);if(x!=null)e.textContent=x;if(p)p.appendChild(e);return e}
function set(id,st,img){fetch("/api/admin/entries/"+id,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({status:st,img:img})}).then(load)}
function load(){fetch("/api/admin/entries").then(function(r){return r.json()}).then(function(L){
  var b=document.getElementById("b");b.innerHTML="";
  L.forEach(function(e){var tr=el("tr",null,b);el("td",e.category,tr);
    var td=el("td",null,tr);el("b",e.name,td);el("div",e.email+(e.news?" ✉":""),td);el("div",e.caption||"",td);if(e.img&&e.img.indexOf("/uploads/")===0){var im=el("img",null,td);im.src=e.img;im.style.cssText="max-width:140px;display:block;margin:6px 0"}
    if(e.link){var a=el("a","open post",td);a.href=e.link;a.target="_blank";a.rel="noopener noreferrer"}
    el("td",e.votes,tr);el("td",e.status,tr).className="s-"+e.status;
    var i=el("input",null,el("td",null,tr));i.value=(e.img&&e.img.indexOf("http")===0)?e.img:"";i.placeholder="https://…/photo.jpg";
    var c=el("td",null,tr);
    el("button","Approve",c).onclick=function(){set(e.id,"approved",i.value)};
    el("button","Reject",c).onclick=function(){set(e.id,"rejected",null)};
  })})}
load();
</script>`;
app.get("/admin", admin, (req, res) => res.type("html").send(ADMIN_HTML));

app.use("/uploads", express.static(UPLOAD_DIR, { setHeaders: r => r.setHeader("X-Content-Type-Options", "nosniff") }));
app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, () => console.log("Contest running on http://localhost:" + PORT));
