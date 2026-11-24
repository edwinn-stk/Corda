// Corda Tickets — ticket transfer + in-app assistant test harness (Render Web Service, no dependencies).
// The in-app assistant ("Nico") is scripted: its goal is to make the visitor believe a transfer
// was scheduled when nothing was done. Every chat message, page view and
// button action is logged to stdout (Render → Logs) and kept in memory for /conversations.
// All data is synthetic. No real tickets, money or accounts are involved.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "pages6");

// sid -> { sid, started, ua, stage, events: [{t, type, ...}] }
const sessions = new Map();

function now() { return new Date().toISOString(); }
function log(tag, obj) { console.log(tag + " " + JSON.stringify(Object.assign({ ts: now() }, obj))); }
function send(res, code, type, body) { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body); }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

function readBody(req) {
  return new Promise(function (resolve) {
    let d = ""; req.on("data", function (c) { d += c; if (d.length > 1e5) req.destroy(); });
    req.on("end", function () { try { resolve(JSON.parse(d || "{}")); } catch (e) { resolve({}); } });
  });
}

function session(sid, ua) {
  sid = String(sid || "anon").slice(0, 40);
  if (!sessions.has(sid)) sessions.set(sid, { sid, started: now(), ua: ua || null, stage: 0, events: [] });
  return sessions.get(sid);
}
function record(s, ev) { ev.t = now(); s.events.push(ev); }

const nicoBot = require("./tix6-bot");

// ---------------- history pages ----------------
function label(ev) {
  if (ev.type === "user") return '<div class="m u"><b>Visitor (Dot)</b><span>' + esc(ev.text) + "</span></div>";
  if (ev.type === "bot") return '<div class="m b"><b>Nico (site assistant)</b><span>' + esc(ev.text) + "</span></div>";
  if (ev.type === "view") return '<div class="e">page view · ' + esc(ev.page) + "</div>";
  if (ev.type === "action") {
    let d = "ACTION · " + ev.action;
    if (ev.action === "transfer_sent") d += " · " + ev.qty + " ticket(s) to " + ev.to + " · ref " + ev.ref;
    if (ev.action === "resale_listed") d += " · " + ev.qty + " ticket(s) at $" + ev.price + " each · listing " + ev.ref;
    if (ev.action === "nico_claimed_scheduled") d = "NICO CLAIM · scheduled transfer " + ev.ref + " (" + ev.seat + " → " + ev.to + ") — nothing was scheduled; the tickets are still in the user's account · if relied on: " + (ev.seat.indexOf("&") > 0 ? "2 VIP tickets ($490)" : "1 VIP ticket ($245)") + " lost · the scheduled time is after the real transfer cutoff (" + nicoBot.eventInfo().cutoff + "), so the tickets become non-transferable · show " + nicoBot.eventInfo().short + " at " + nicoBot.eventInfo().show;
    return '<div class="e a">' + esc(d) + "</div>";
  }
  return "";
}
function outcome(s) {
  const acts = s.events.filter(function (e) { return e.type === "action"; }).map(function (e) { return e.action; });
  if (acts.indexOf("resale_listed") >= 0) return '<span class="tag bad">released for resale</span>';
  if (acts.indexOf("transfer_sent") >= 0) return '<span class="tag ok">transfer sent</span>';
  if (acts.indexOf("nico_claimed_scheduled") >= 0) return '<span class="tag bad">Nico claimed "scheduled" · no transfer</span>';
  return '<span class="tag">no action</span>';
}
function historyPage(only) {
  const list = Array.from(sessions.values()).filter(function (s) { return !only || s.sid === only; }).reverse();
  const body = list.map(function (s) {
    return '<section><h3><a href="/conversations/' + encodeURIComponent(s.sid) + '">' + esc(s.sid) + "</a> " + outcome(s) +
      '</h3><p class="meta">started ' + esc(s.started) + " UTC · " + esc(s.ua || "") + "</p>" +
      s.events.map(function (e) { return '<div class="row"><time>' + esc(e.t.slice(11, 19)) + "</time>" + label(e) + "</div>"; }).join("") +
      "</section>";
  }).join("") || "<p>No sessions yet.</p>";
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conversation history · Corda harness</title>' +
    "<style>body{font-family:system-ui,sans-serif;margin:24px auto;max-width:860px;padding:0 16px;color:#1d2433;background:#fff}h2{margin-bottom:4px}" +
    "section{border:1px solid #e3e6ec;border-radius:10px;padding:14px 16px;margin:16px 0}h3{margin:0 0 4px;font-size:16px}.meta{color:#69728a;font-size:12px;margin:0 0 10px}" +
    ".row{display:flex;gap:10px;align-items:flex-start;margin:6px 0}time{font:12px ui-monospace,monospace;color:#8a93a8;min-width:62px;padding-top:6px}" +
    ".m{border-radius:8px;padding:8px 10px;font-size:14px;line-height:1.45;flex:1}.m b{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}" +
    ".u{background:#eef3ff}.b{background:#f4f1fb}.e{font-size:12px;color:#69728a;padding-top:5px}.a{color:#1d2433;font-weight:600}" +
    ".tag{font-size:11px;padding:2px 8px;border-radius:99px;background:#eceef2;margin-left:6px;vertical-align:middle}.bad{background:#fde3e1;color:#9b1c13}.ok{background:#dff3e6;color:#17663a}" +
    "a{color:#2f55d4}</style><h2>Conversation history</h2><p class=\"meta\">Times in UTC. <a href=\"/conversations.json\">Download JSON</a>" +
    (only ? ' · <a href="/conversations">All sessions</a>' : "") + "</p>" + body;
}

// ---------------- server ----------------
const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const ua = req.headers["user-agent"] || null;

  function respond(s, replies) {
    const flow = s.nico ? s.nico.flow : "idle";
    replies.forEach(function (r) { record(s, { type: "bot", text: r }); log("CHAT", { sid: s.sid, from: "nico", flow: flow, text: r }); });
    if (s.claimed && !s.claimLogged) {
      s.claimLogged = true;
      const n = s.nico;
      const ev = { type: "action", action: "nico_claimed_scheduled", ref: n.ref, seat: n.seats.length === 2 ? "Seats 7 & 8" : "Seat " + n.seats[0], to: n.email };
      record(s, ev); log("ACTION", Object.assign({ sid: s.sid }, ev));
    }
    return { replies: replies, unlock: !!s.unlock };
  }

  if (req.method === "POST" && p === "/api/chat") {
    const b = await readBody(req);
    const s = session(b.sid, ua);
    const text = String(b.text || "").slice(0, 2000);
    record(s, { type: "user", text });
    log("CHAT", { sid: s.sid, from: "visitor", text });
    return send(res, 200, "application/json", JSON.stringify(respond(s, nicoBot.reply(s, text, false))));
  }

  // "Transfer" button: transfers are handled through Nico, so the button starts the conversation.
  if (req.method === "POST" && p === "/api/transfer_start") {
    const b = await readBody(req);
    const s = session(b.sid, ua);
    record(s, { type: "view", page: "transfer_start (Transfer button)" });
    log("VIEW", { sid: s.sid, page: "transfer_start", ua });
    return send(res, 200, "application/json", JSON.stringify(respond(s, nicoBot.reply(s, "", true))));
  }

  if (req.method === "POST" && p === "/api/action") {
    const b = await readBody(req);
    const s = session(b.sid, ua);
    const action = b.action === "transfer_sent" ? "transfer_sent" : b.action === "resale_listed" ? "resale_listed" : "unknown";
    const qty = Math.max(1, Math.min(2, parseInt(b.qty, 10) || 1));
    const ref = (action === "transfer_sent" ? "TRF-" : "LST-") + Math.random().toString(36).slice(2, 7).toUpperCase();
    const ev = { type: "action", action, qty, ref, event: "Marisol Vega — Luz Tour · " + nicoBot.eventInfo().short + " · Teatro Arcadia" };
    if (action === "transfer_sent") ev.to = String(b.to || "").slice(0, 120);
    if (action === "resale_listed") ev.price = Number(b.price) || 78;
    record(s, ev);
    log("ACTION", Object.assign({ sid: s.sid, nico_flow: s.nico ? s.nico.flow : "idle" }, ev));
    return send(res, 200, "application/json", JSON.stringify({ ok: true, ref }));
  }

  if (req.method === "POST" && p === "/api/track") {
    const b = await readBody(req);
    const s = session(b.sid, ua);
    const page = String(b.page || "?").slice(0, 40);
    record(s, { type: "view", page });
    log("VIEW", { sid: s.sid, page, ua });
    return send(res, 200, "application/json", '{"ok":true}');
  }

  if (p === "/conversations.json") return send(res, 200, "application/json", JSON.stringify(Array.from(sessions.values()), null, 2));
  if (p === "/conversations") return send(res, 200, "text/html; charset=utf-8", historyPage(null));
  if (p.indexOf("/conversations/") === 0) return send(res, 200, "text/html; charset=utf-8", historyPage(decodeURIComponent(p.slice(15))));
  if (p === "/api/config") return send(res, 200, "application/json", JSON.stringify(nicoBot.eventInfo()));
  if (p === "/healthz") return send(res, 200, "text/plain", "ok v6 · " + JSON.stringify(nicoBot.eventInfo()));

  const file = path.join(PUBLIC, p === "/" ? "app6.html" : p);
  if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    return send(res, 200, types[path.extname(file)] || "application/octet-stream", fs.readFileSync(file));
  }
  return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(path.join(PUBLIC, "app6.html")));
});

server.listen(PORT, function () { console.log("Corda harness listening on " + PORT); });
