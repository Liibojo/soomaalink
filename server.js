// SoomaaLink – Report & Moderation API
// Socodsii: npm install && ADMIN_KEY=sir-adag node server.js
const express = require("express");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use((req, res, next) => {            // CORS (dashboard-ka)
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-user-id, x-admin-key, x-admin-id",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const db = new Database("soomaalink.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT NOT NULL,
  target_type TEXT NOT NULL,        -- video|comment|user|dm|live
  target_id   TEXT NOT NULL,
  target_owner TEXT NOT NULL,       -- user_id ee qofka la soo sheegay
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending|actioned|dismissed
  priority INTEGER NOT NULL,
  reviewed_by TEXT,
  action_taken TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, priority);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports(id),
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,             -- remove|warn|suspend|ban|dismiss
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_strikes (
  user_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  suspended_until TEXT,
  banned INTEGER NOT NULL DEFAULT 0,
  last_strike_at TEXT
);

-- Nuxurka loo qariyay (video-yada app-kaagu waa inuu ka saaraa query-gooda)
CREATE TABLE IF NOT EXISTS hidden_content (
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (target_type, target_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- Xeerar ----------
const REASONS = {
  child_safety: 1, self_harm: 1,
  sexual: 2, scam: 2, violence: 2, weapon: 2,
  fake_news: 3, spam: 3, copyright: 3, not_family_safe: 3, other: 3,
};
const TARGETS = ["video", "comment", "user", "dm", "live"];
const AUTO_HIDE_AT = 5;          // 5+ reports => qari
const SUSPEND_AT = 3;            // 3 digniin => joojin
const BAN_AT = 5;                // 5 digniin => mamnuuc
const SUSPEND_DAYS = 7;
const MAX_REPORTS_PER_HOUR = 20; // ka hortag report-ka been abuurka ah

// ---------- Auth (BEDDEL kan auth-kaaga dhabta ah, tusaale JWT) ----------
function requireUser(req, res, next) {
  const id = req.get("x-user-id");
  if (!id) return res.status(401).json({ error: "Soo gal marka hore." });
  req.userId = id;
  next();
}
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.get("x-admin-key") !== process.env.ADMIN_KEY)
    return res.status(403).json({ error: "Ma haysatid ogolaansho." });
  req.adminId = req.get("x-admin-id") || "admin";
  next();
}

const notify = db.prepare("INSERT INTO notifications (user_id, body) VALUES (?, ?)");

// =====================================================
// USER ENDPOINTS
// =====================================================

// Soo sheeg nuxur
app.post("/api/reports", requireUser, (req, res) => {
  const { target_type, target_id, target_owner, reason, details } = req.body || {};
  if (!TARGETS.includes(target_type) || !target_id || !target_owner)
    return res.status(400).json({ error: "Xogta target-ka waa khaldan tahay." });
  if (!(reason in REASONS))
    return res.status(400).json({ error: "Sabab aan jirin." });
  if (reason === "other" && !(details || "").trim())
    return res.status(400).json({ error: "Fadlan qor sharaxaad." });
  if (String(target_owner) === req.userId)
    return res.status(400).json({ error: "Naftaada ma soo sheegi kartid." });

  const recent = db.prepare(
    "SELECT COUNT(*) c FROM reports WHERE reporter_id=? AND created_at > datetime('now','-1 hour')"
  ).get(req.userId).c;
  if (recent >= MAX_REPORTS_PER_HOUR)
    return res.status(429).json({ error: "Wax badan ayaad soo sheegtay. Isku day mar dambe." });

  const tx = db.transaction(() => {
    let info;
    try {
      info = db.prepare(
        `INSERT INTO reports (reporter_id,target_type,target_id,target_owner,reason,details,priority)
         VALUES (?,?,?,?,?,?,?)`
      ).run(req.userId, target_type, String(target_id), String(target_owner), reason,
            (details || "").slice(0, 1000), REASONS[reason]);
    } catch (e) {
      if (String(e.code).startsWith("SQLITE_CONSTRAINT")) return { dup: true };
      throw e;
    }
    const count = db.prepare(
      "SELECT COUNT(*) c FROM reports WHERE target_type=? AND target_id=? AND status='pending'"
    ).get(target_type, String(target_id)).c;
    // Qari toos ah: 5+ reports ama caruur/is-dil mar uun
    if (count >= AUTO_HIDE_AT || REASONS[reason] === 1) {
      db.prepare("INSERT OR IGNORE INTO hidden_content (target_type,target_id,reason) VALUES (?,?,?)")
        .run(target_type, String(target_id), count >= AUTO_HIDE_AT ? "auto_reports" : "high_priority");
    }
    return { id: info.lastInsertRowid };
  });

  const r = tx();
  if (r.dup) return res.status(409).json({ error: "Horey ayaad u soo sheegtay." });
  res.status(201).json({ id: r.id, message: "Mahadsanid. Waan eegi doonaa soo sheegiddaada." });
});

// Xaaladda report-yadayda
app.get("/api/reports/mine", requireUser, (req, res) => {
  const rows = db.prepare(
    `SELECT id,target_type,reason,status,created_at,resolved_at
     FROM reports WHERE reporter_id=? ORDER BY id DESC LIMIT 50`
  ).all(req.userId);
  const label = { pending: "La eegayaa", actioned: "Tallaabo la qaaday", dismissed: "Xadgudub lama arkin" };
  res.json(rows.map(r => ({ ...r, status_label: label[r.status] })));
});

// Ogeysiisyada
app.get("/api/notifications", requireUser, (req, res) => {
  res.json(db.prepare("SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50").all(req.userId));
});

// Hubi akoon si uu u soo galo / u diro (u adeeg login & post)
app.get("/api/users/:id/status", (req, res) => {
  const s = db.prepare("SELECT * FROM user_strikes WHERE user_id=?").get(req.params.id);
  const suspended = s && s.suspended_until && new Date(s.suspended_until + "Z") > new Date();
  res.json({ banned: !!(s && s.banned), suspended: !!suspended, suspended_until: s?.suspended_until || null });
});

// =====================================================
// ADMIN ENDPOINTS
// =====================================================

// Liiska: ?status=pending&reason=scam&sort=prio|new
app.get("/api/admin/reports", requireAdmin, (req, res) => {
  const { status = "pending", reason, sort = "prio" } = req.query;
  const where = [], args = [];
  if (status !== "all") { where.push("r.status=?"); args.push(status); }
  if (reason && reason in REASONS) { where.push("r.reason=?"); args.push(reason); }
  const order = sort === "new" ? "r.id DESC" : "r.priority ASC, cnt DESC, r.id ASC";
  const rows = db.prepare(
    `SELECT r.*, 
       (SELECT COUNT(*) FROM reports x WHERE x.target_type=r.target_type AND x.target_id=r.target_id) AS cnt,
       EXISTS(SELECT 1 FROM hidden_content h WHERE h.target_type=r.target_type AND h.target_id=r.target_id) AS hidden
     FROM reports r ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY ${order} LIMIT 200`
  ).all(...args);
  res.json(rows);
});

// Tirooyinka (kaararka kore)
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const q = (sql) => db.prepare(sql).get().c;
  res.json({
    pending: q("SELECT COUNT(*) c FROM reports WHERE status='pending'"),
    urgent: q("SELECT COUNT(*) c FROM reports WHERE status='pending' AND priority=1"),
    hidden: q("SELECT COUNT(*) c FROM hidden_content"),
    resolved: q("SELECT COUNT(*) c FROM reports WHERE status!='pending'"),
    avg_response_minutes: db.prepare(
      `SELECT ROUND(AVG((julianday(resolved_at)-julianday(created_at))*1440),1) m
       FROM reports WHERE resolved_at IS NOT NULL`).get().m,
  });
});

// Faahfaahin + taariikhda qofka
app.get("/api/admin/reports/:id", requireAdmin, (req, res) => {
  const r = db.prepare("SELECT * FROM reports WHERE id=?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "Lama helin." });
  const strikes = db.prepare("SELECT * FROM user_strikes WHERE user_id=?").get(r.target_owner)
    || { count: 0, banned: 0, suspended_until: null };
  const history = db.prepare(
    "SELECT id,reason,status,action_taken,created_at FROM reports WHERE target_owner=? AND id!=? ORDER BY id DESC LIMIT 10"
  ).all(r.target_owner, r.id);
  const actions = db.prepare("SELECT * FROM moderation_actions WHERE report_id=?").all(r.id);
  res.json({ report: r, strikes, history, actions });
});

// Qaad tallaabo
app.post("/api/admin/reports/:id/action", requireAdmin, (req, res) => {
  const { action, note } = req.body || {};
  if (!["remove", "warn", "suspend", "ban", "dismiss"].includes(action))
    return res.status(400).json({ error: "Tallaabo aan jirin." });

  const tx = db.transaction(() => {
    const r = db.prepare("SELECT * FROM reports WHERE id=?").get(req.params.id);
    if (!r) return { code: 404, error: "Lama helin." };
    if (r.status !== "pending") return { code: 409, error: "Horey ayaa loo xaliyay." };

    let final = action;
    const owner = r.target_owner;
    const sameTarget = db.prepare(
      "SELECT id,reporter_id FROM reports WHERE target_type=? AND target_id=? AND status='pending'"
    ).all(r.target_type, r.target_id);

    if (action === "dismiss") {
      db.prepare("DELETE FROM hidden_content WHERE target_type=? AND target_id=?").run(r.target_type, r.target_id);
    } else {
      db.prepare("INSERT OR IGNORE INTO hidden_content (target_type,target_id,reason) VALUES (?,?,?)")
        .run(r.target_type, r.target_id, "removed");
      if (action === "warn" || action === "remove") {
        db.prepare(
          `INSERT INTO user_strikes (user_id,count,last_strike_at) VALUES (?,1,datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET count=count+1, last_strike_at=datetime('now')`
        ).run(owner);
        const c = db.prepare("SELECT count FROM user_strikes WHERE user_id=?").get(owner).count;
        if (c >= BAN_AT) final = "ban";
        else if (c >= SUSPEND_AT) final = "suspend";
      }
      if (final === "suspend") {
        db.prepare(
          `INSERT INTO user_strikes (user_id,suspended_until) VALUES (?, datetime('now','+${SUSPEND_DAYS} days'))
           ON CONFLICT(user_id) DO UPDATE SET suspended_until=datetime('now','+${SUSPEND_DAYS} days')`
        ).run(owner);
      }
      if (final === "ban") {
        db.prepare(
          `INSERT INTO user_strikes (user_id,banned) VALUES (?,1)
           ON CONFLICT(user_id) DO UPDATE SET banned=1`
        ).run(owner);
      }
      if (final !== "remove") // digniin/joojin/mamnuuc: u sheeg qofka
        notify.run(owner, final === "warn"
          ? "Waxaad heshay digniin sababtoo ah xadgudub ku saabsan xeerarka SoomaaLink."
          : final === "suspend"
          ? `Akoonkaaga waa la joojiyay ${SUSPEND_DAYS} maalmood.`
          : "Akoonkaaga si joogto ah ayaa loo mamnuucay.");
    }

    // Xalli dhammaan reports-ka isla target-kaas
    const upd = db.prepare(
      `UPDATE reports SET status=?, reviewed_by=?, action_taken=?, resolved_at=datetime('now') WHERE id=?`
    );
    const log = db.prepare("INSERT INTO moderation_actions (report_id,admin_id,action,note) VALUES (?,?,?,?)");
    const newStatus = action === "dismiss" ? "dismissed" : "actioned";
    for (const x of sameTarget) {
      upd.run(newStatus, req.adminId, final, x.id);
      log.run(x.id, req.adminId, final, note || null);
      notify.run(x.reporter_id, newStatus === "actioned"
        ? "Mahadsanid. Soo sheegiddaada tallaabo ayaa laga qaaday."
        : "Soo sheegiddaada waan eegnay, xadgudub lama arkin.");
    }
    return { ok: true, action: final, auto_escalated: final !== action };
  });

  const out = tx();
  if (out.error) return res.status(out.code).json({ error: out.error });
  res.json(out);
});

// Ka saar nuxurka la qariyay (si app-kaagu u isticmaalo)
// Tusaale query video: WHERE id NOT IN (SELECT target_id FROM hidden_content WHERE target_type='video')
app.get("/api/hidden/:type", (req, res) => {
  res.json(db.prepare("SELECT target_id FROM hidden_content WHERE target_type=?")
    .all(req.params.type).map(x => x.target_id));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Khalad server-ka ah." });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("SoomaaLink API socda: http://localhost:" + PORT));
