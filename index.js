// ============================================================================
// ABOD.IO — WebSocket Game Server
// Persistent process · Real-time push · Single game state
// ============================================================================
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3001;
const ADMIN_PW = process.env.ADMIN_PW || 'changeme';

// ---- Config ----
const W = 4000, H = 4000, FOOD_N = 300;
const SM = 10, SPLIT_MIN = 35, MAX_CELLS = 16, EAT_R = 1.25, BSPD = 5, MAX_MASS = 100000;
const CLR = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9','#F8B500','#FF69B4'];
const FCLR = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F'];

// ---- Utilities ----
const rad = m => Math.sqrt(m) * 4;
const spd = m => BSPD * Math.pow(m, -0.1);
const dst = (x1, y1, x2, y2) => Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
const clp = (v, a, b) => v < a ? a : v > b ? b : v;
const uid = () => Math.random().toString(36).slice(2, 11);
const pick = a => a[(Math.random() * a.length) | 0];
const rp = (m = 100) => ({ x: m + Math.random() * (W - m * 2), y: m + Math.random() * (H - m * 2) });

function com(cells) {
  if (!cells.length) return { x: W / 2, y: H / 2 };
  let t = 0, cx = 0, cy = 0;
  for (const c of cells) { cx += c.x * c.m; cy += c.y * c.m; t += c.m; }
  return { x: cx / t, y: cy / t };
}
function tmass(cells) { let s = 0; for (const c of cells) s += c.m; return s; }

// ---- Game State ----
const players = new Map(); // id -> PlayerData
let food = [];
let foodVer = 0;
const kicked = new Map(); // lowercase name -> reason
let gen = 1;
let lastTick = Date.now();

// ---- Debug Stats ----
const dbg = { tickMs: 0, serMs: 0, payloadBytes: 0, playerCount: 0, cellCount: 0,
  foodEaten: 0, tickCount: 0, lastTickTime: 0, avgTickMs: 0, tickHistory: [] };

// ---- Activity Log ----
const activityLog = []; // { ts, type: 'join'|'leave', name }
let lastBroadcastEvLen = 0; // track what's been sent
function logActivity(type, name) {
  activityLog.push({ ts: Date.now(), type, name });
  if (activityLog.length > 200) activityLog.splice(0, activityLog.length - 200);
}

// ---- Connection Tracking ----
// Map<ws, { playerId: string|null, isAdmin: boolean }>
const connections = new Map();

// ---- Init Food ----
function initFood() {
  food = [];
  for (let i = 0; i < FOOD_N; i++) { const p = rp(20); food.push({ x: p.x, y: p.y, c: pick(FCLR) }); }
  foodVer++;
}
initFood();

// ---- Device Detection ----
function parseDevice(ua) {
  if (!ua || ua === 'Unknown') return 'Unknown';
  let device = '';
  if (/iPad/.test(ua)) device = 'iPad';
  else if (/iPhone/.test(ua)) device = 'iPhone';
  else if (/Android/.test(ua)) device = /Mobile/.test(ua) ? 'Android Phone' : 'Android Tablet';
  else if (/Macintosh|Mac OS/.test(ua)) device = 'Mac';
  else if (/Windows/.test(ua)) device = 'Windows';
  else if (/Linux/.test(ua)) device = 'Linux';
  else device = 'Other';
  if (/CriOS|Chrome/.test(ua) && !/Edg/.test(ua)) device += ' · Chrome';
  else if (/Safari/.test(ua) && !/Chrome/.test(ua)) device += ' · Safari';
  else if (/Firefox|FxiOS/.test(ua)) device += ' · Firefox';
  else if (/Edg/.test(ua)) device += ' · Edge';
  return device;
}

// ============================================================================
// GAME TICK
// ============================================================================
function tick() {
  const now = Date.now();
  let dms = now - lastTick;
  if (dms < 15) return;
  if (dms > 500) dms = 500;
  lastTick = now;
  const dt = dms / 33.33;

  // ---- Bot AI ----
  for (const p of players.values()) {
    if (!p.isBot || !p.bot) continue;
    const b = p.bot, c = com(p.cells), mm = tmass(p.cells);
    if (now >= b.rt) {
      b.rt = now + 400 + Math.random() * 1500;
      let tx = c.x + Math.random() * 400 - 200, ty = c.y + Math.random() * 400 - 200, best = -1, flee = false;
      for (const o of players.values()) {
        if (o.id === p.id) continue;
        const oc = com(o.cells), om = tmass(o.cells), d = dst(c.x, c.y, oc.x, oc.y);
        if (om > mm * 1.3 && d < 600) {
          const a = Math.atan2(c.y - oc.y, c.x - oc.x);
          tx = c.x + Math.cos(a) * 700; ty = c.y + Math.sin(a) * 700; flee = true; break;
        }
      }
      if (!flee) {
        for (const o of players.values()) {
          if (o.id === p.id) continue;
          const oc = com(o.cells), om = tmass(o.cells), d = dst(c.x, c.y, oc.x, oc.y);
          if (mm > om * EAT_R && d < 900) { const sc = om / (d + 1) * 100; if (sc > best) { best = sc; tx = oc.x; ty = oc.y; } }
        }
        if (best < 1) {
          let nd = Infinity;
          for (const f of food) { const d = dst(c.x, c.y, f.x, f.y); if (d < nd) { nd = d; tx = f.x; ty = f.y; } }
        }
      }
      b.tx = clp(tx, 50, W - 50); b.ty = clp(ty, 50, H - 50);
    }
    p.mx = b.tx; p.my = b.ty;
    // Bot split
    if (now > b.scd && mm > SPLIT_MIN * 2) {
      for (const o of players.values()) {
        if (o.id === p.id) continue;
        const oc = com(o.cells), om = tmass(o.cells), d = dst(c.x, c.y, oc.x, oc.y);
        if (mm > om * 3 && d < 350 && d > 80) { doSplit(p); b.scd = now + 12000; break; }
      }
    }
  }

  // ---- Movement & Physics ----
  for (const p of players.values()) {
    // Feed bonus
    if (p.feedBonus > 0) {
      const chunk = Math.min(p.feedBonus, 20);
      if (p.cells.length > 0) p.cells[0].m = Math.min(p.cells[0].m + chunk, MAX_MASS);
      p.feedBonus -= chunk;
    }
    // Move bots only (human positions come from client)
    if (p.isBot) {
      for (const cell of p.cells) {
        const dx = p.mx - cell.x, dy = p.my - cell.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d > 5) { const s = spd(cell.m) * dt; cell.x += (dx / d) * s; cell.y += (dy / d) * s; }
        const r = rad(cell.m);
        cell.x = clp(cell.x, r, Math.max(r, W - r)); cell.y = clp(cell.y, r, Math.max(r, H - r));
      }
    }
    // Merge/push own cells
    for (let i = 0; i < p.cells.length; i++) {
      for (let j = i + 1; j < p.cells.length; j++) {
        const a = p.cells[i], b2 = p.cells[j], d = dst(a.x, a.y, b2.x, b2.y), md = rad(a.m) + rad(b2.m);
        if (d < md * 0.5 && p.cells.length > 1) { a.m += b2.m; p.cells.splice(j, 1); j--; continue; }
        if (d < md && d > 0.1) { const o = (md - d) / d * 0.5, px = (b2.x - a.x) * o, py = (b2.y - a.y) * o; a.x -= px; a.y -= py; b2.x += px; b2.y += py; }
      }
    }
    // Decay & mass cap
    for (const cell of p.cells) {
      if (cell.m > 200) cell.m *= Math.pow(0.9994, dt);
      if (cell.m > MAX_MASS) cell.m = MAX_MASS;
    }
  }

  // ---- Food collisions — BOTS ONLY ----
  let foodChanged = false, foodEatenThisTick = 0;
  for (const p of players.values()) {
    if (!p.isBot) continue;
    for (const cell of p.cells) {
      const cr = rad(cell.m), crSq = cr * cr;
      for (let i = 0; i < food.length; i++) {
        const f = food[i], fdx = cell.x - f.x, fdy = cell.y - f.y;
        if (fdx * fdx + fdy * fdy < crSq) {
          cell.m += 1; foodEatenThisTick++;
          const np = rp(20); food[i] = { x: np.x, y: np.y, c: pick(FCLR) };
          foodChanged = true;
        }
      }
    }
  }
  if (foodChanged) foodVer++;
  dbg.foodEaten = foodEatenThisTick;

  // ---- PvP — at least one side must be a bot ----
  const all = [];
  for (const p of players.values()) for (const c of p.cells) all.push({ cell: c, p });
  const eaten = new Set();
  for (let i = 0; i < all.length; i++) {
    if (eaten.has(all[i].cell.id)) continue;
    for (let j = i + 1; j < all.length; j++) {
      if (eaten.has(all[j].cell.id)) continue;
      const { cell: c1, p: p1 } = all[i], { cell: c2, p: p2 } = all[j];
      if (p1.id === p2.id) continue;
      if (!p1.isBot && !p2.isBot) continue;
      const d = dst(c1.x, c1.y, c2.x, c2.y);
      if (c1.m > c2.m * EAT_R && d < rad(c1.m) - rad(c2.m) * 0.6) { c1.m += c2.m; p2.cells = p2.cells.filter(c => c.id !== c2.id); eaten.add(c2.id); }
      else if (c2.m > c1.m * EAT_R && d < rad(c2.m) - rad(c1.m) * 0.6) { c2.m += c1.m; p1.cells = p1.cells.filter(c => c.id !== c1.id); eaten.add(c1.id); break; }
    }
  }

  // ---- Respawn dead players ----
  for (const p of players.values()) {
    if (p.cells.length === 0) {
      const pos = rp();
      p.cells = [{ id: uid(), x: pos.x, y: pos.y, m: SM, c: p.color }];
      if (p.bot) { p.bot.tx = pos.x; p.bot.ty = pos.y; }
    }
  }
}

function doSplit(p) {
  if (p.cells.length >= MAX_CELLS) return;
  const news = [];
  const c = com(p.cells), ba = Math.atan2(p.my - c.y, p.mx - c.x);
  for (const cell of p.cells) {
    if (cell.m >= SPLIT_MIN && p.cells.length + news.length < MAX_CELLS) {
      const half = Math.floor(cell.m / 2); cell.m = half;
      const a = ba + (Math.random() - 0.5) * 0.5, r = rad(half);
      news.push({ id: uid(), x: cell.x + Math.cos(a) * (r + 100), y: cell.y + Math.sin(a) * (r + 100), m: half, c: p.color });
    }
  }
  p.cells.push(...news);
}

// ============================================================================
// SERIALIZATION
// ============================================================================
function serPlayers() {
  const out = [];
  for (const p of players.values()) {
    out.push([p.id, p.name, p.color, p.isBot ? 1 : 0,
      p.cells.map(c => [c.id, Math.round(c.x), Math.round(c.y), Math.round(c.m * 10) / 10, c.c]),
      p.emoji || '']);
  }
  return out;
}

function mkLb() {
  const lb = [];
  for (const p of players.values()) lb.push({ n: p.name, m: Math.floor(tmass(p.cells)), b: p.isBot });
  lb.sort((a, b) => b.m - a.m);
  return lb.slice(0, 10);
}

function serFood() { return food.map(f => [Math.round(f.x), Math.round(f.y), f.c]); }

function sendAdminState(ws) {
  let totalCells = 0;
  const playerList = [];
  for (const p of players.values()) {
    totalCells += p.cells.length;
    playerList.push({ id: p.id, name: p.name, mass: Math.floor(tmass(p.cells)), isBot: p.isBot,
      cells: p.cells.length, feedPending: p.feedBonus, device: p.device || 'Unknown' });
  }
  const kickedList = [];
  for (const [name, reason] of kicked) kickedList.push({ name, reason });
  ws.send(JSON.stringify({
    t: 'as', players: playerList, kicked: kickedList,
    foodCount: food.length, foodVer, gen,
    debug: { ...dbg, playerCount: players.size, cellCount: totalCells },
    activity: activityLog.slice(-50),
  }));
}

// ============================================================================
// HTTP SERVER (status endpoint)
// ============================================================================
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/' || req.url === '/status') {
    let h = 0, b = 0;
    for (const p of players.values()) { if (p.isBot) b++; else h++; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ s: 'ok', h, b }));
    return;
  }
  res.writeHead(404); res.end('Not Found');
});

// ============================================================================
// WEBSOCKET SERVER
// ============================================================================
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const conn = { playerId: null, isAdmin: false };
  connections.set(ws, conn);

  ws.on('message', (raw) => {
    try { handleMessage(ws, conn, JSON.parse(raw.toString())); }
    catch (_) { /* ignore malformed */ }
  });

  ws.on('close', () => {
    if (conn.playerId) {
      const p = players.get(conn.playerId);
      if (p) logActivity('leave', p.name);
      players.delete(conn.playerId);
    }
    connections.delete(ws);
  });

  ws.on('error', () => {});

  // Keepalive ping every 30s
  const ping = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
    else clearInterval(ping);
  }, 30000);
  ws.on('close', () => clearInterval(ping));
});

function handleMessage(ws, conn, msg) {
  switch (msg.t) {
    // ---- Join ----
    case 'j': {
      const name = (msg.name || 'Player').trim().slice(0, 20);
      const kickReason = kicked.get(name.toLowerCase());
      if (kickReason) { ws.send(JSON.stringify({ t: 'k', reason: kickReason })); return; }
      // Remove stale player with same name
      for (const [eid, ep] of players) {
        if (!ep.isBot && ep.name.toLowerCase() === name.toLowerCase()) {
          for (const [ows, oc] of connections) {
            if (oc.playerId === eid && ows !== ws && ows.readyState === 1) {
              ows.send(JSON.stringify({ t: 'k', reason: 'Another session joined with your name' }));
            }
          }
          players.delete(eid);
        }
      }
      const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const device = parseDevice(msg.ua || 'Unknown');
      const color = (msg.color && /^#[0-9A-Fa-f]{6}$/.test(msg.color)) ? msg.color : pick(CLR);
      const emoji = (msg.emoji && typeof msg.emoji === 'string' && msg.emoji.length <= 4) ? msg.emoji : '';
      const pos = rp();
      const cell = { id: uid(), x: pos.x, y: pos.y, m: SM, c: color };
      const p = { id, name, color, emoji, isBot: false, feedBonus: 0, cells: [cell],
        mx: pos.x, my: pos.y, lastPing: Date.now(), device };
      players.set(id, p);
      conn.playerId = id;
      logActivity('join', name);
      ws.send(JSON.stringify({
        t: 'w', id, mc: cell, w: W, h: H,
        f: serFood(), fv: foodVer, gen,
        p: serPlayers(), lb: mkLb(),
      }));
      break;
    }
    // ---- Input (mouse + cells) ----
    case 'i': {
      const p = players.get(conn.playerId);
      if (!p || p.isBot) return;
      if (msg.x !== undefined) p.mx = msg.x;
      if (msg.y !== undefined) p.my = msg.y;
      if (msg.cells) {
        for (const cd of msg.cells) {
          const cell = p.cells.find(c => c.id === cd[0]);
          if (cell) {
            cell.x = cd[1]; cell.y = cd[2];
            // Only accept mass if >= server value (prevents overwriting admin feed)
            if (typeof cd[3] === 'number' && cd[3] >= cell.m) cell.m = Math.min(cd[3], MAX_MASS);
          }
        }
      }
      p.lastPing = Date.now();
      break;
    }
    // ---- Split ----
    case 's': {
      const p = players.get(conn.playerId);
      if (p) { p.lastPing = Date.now(); doSplit(p); }
      break;
    }
    // ---- Leave ----
    case 'l': {
      if (conn.playerId) {
        const p = players.get(conn.playerId);
        if (p) logActivity('leave', p.name);
        players.delete(conn.playerId);
        conn.playerId = null;
      }
      break;
    }
    // ---- Admin Auth ----
    case 'aa': {
      if (msg.pw === ADMIN_PW) {
        conn.isAdmin = true;
        ws.send(JSON.stringify({ t: 'aa', ok: 1 }));
        sendAdminState(ws);
      } else {
        ws.send(JSON.stringify({ t: 'aa', ok: 0 }));
      }
      break;
    }
    // ---- Admin Reset ----
    case 'ar': {
      if (!conn.isAdmin) return;
      players.clear(); kicked.clear(); initFood(); gen++;
      ws.send(JSON.stringify({ t: 'am', ok: 1, action: 'admin_reset' }));
      break;
    }
    // ---- Admin Add Bot ----
    case 'ab': {
      if (!conn.isAdmin) return;
      const botName = ((msg.name || '').trim() || '🤖 Bot').slice(0, 20);
      const botMass = Math.max(SM, Math.min(msg.mass || 50, 10000));
      const botId = `bot-${uid()}`;
      const color = pick(CLR), pos = rp();
      players.set(botId, {
        id: botId, name: botName, color, isBot: true, feedBonus: 0,
        cells: [{ id: uid(), x: pos.x, y: pos.y, m: botMass, c: color }],
        mx: pos.x, my: pos.y, lastPing: Date.now(), device: 'Bot',
        bot: { tx: pos.x, ty: pos.y, rt: Date.now() + 1000, scd: Date.now() + 5000 },
      });
      ws.send(JSON.stringify({ t: 'am', ok: 1, action: 'admin_add_bot', botId }));
      break;
    }
    // ---- Admin Remove ----
    case 'ax': {
      if (!conn.isAdmin) return;
      const reason = msg.reason || 'No reason given';
      const target = players.get(msg.pid);
      if (target) {
        kicked.set(target.name.toLowerCase(), reason);
        for (const [ows, oc] of connections) {
          if (oc.playerId === msg.pid && ows.readyState === 1) {
            ows.send(JSON.stringify({ t: 'k', reason }));
          }
        }
        players.delete(msg.pid);
      }
      ws.send(JSON.stringify({ t: 'am', ok: 1, action: 'admin_remove' }));
      break;
    }
    // ---- Admin Unkick ----
    case 'au': {
      if (!conn.isAdmin) return;
      if (msg.name) kicked.delete(msg.name.toLowerCase());
      ws.send(JSON.stringify({ t: 'am', ok: 1, action: 'admin_unkick' }));
      break;
    }
    // ---- Admin Feed ----
    case 'af': {
      if (!conn.isAdmin) return;
      const p = players.get(msg.pid);
      if (p) p.feedBonus += (msg.amount || 100);
      ws.send(JSON.stringify({ t: 'am', ok: 1, action: 'admin_feed' }));
      break;
    }
  }
}

// ============================================================================
// GAME LOOP & BROADCAST
// ============================================================================
const TICK_RATE = 60;
const BROADCAST_RATE = 20;
let tickCount = 0;
let lastBroadcastFv = -1;

setInterval(() => {
  const t0 = performance.now();
  tick();
  const tickMs = performance.now() - t0;
  dbg.tickMs = tickMs;
  dbg.tickCount++;
  dbg.tickHistory.push(tickMs);
  if (dbg.tickHistory.length > 50) dbg.tickHistory.shift();
  dbg.avgTickMs = dbg.tickHistory.reduce((a, b) => a + b, 0) / dbg.tickHistory.length;
  dbg.lastTickTime = Date.now();

  tickCount++;
  if (tickCount % Math.round(TICK_RATE / BROADCAST_RATE) === 0) {
    broadcastState();
    broadcastAdminState();
  }
}, Math.round(1000 / TICK_RATE));

function broadcastState() {
  const sp = serPlayers();
  const lb = mkLb();
  const includeFood = foodVer !== lastBroadcastFv;
  const state = { t: 'u', p: sp, lb, fv: foodVer, gen };
  if (includeFood) { state.f = serFood(); lastBroadcastFv = foodVer; }
  // Include new activity events since last broadcast
  if (activityLog.length > lastBroadcastEvLen) {
    state.ev = activityLog.slice(lastBroadcastEvLen);
    lastBroadcastEvLen = activityLog.length;
  }
  const raw = JSON.stringify(state);
  dbg.payloadBytes = raw.length;
  for (const [ws, conn] of connections) {
    if (conn.playerId && ws.readyState === 1) ws.send(raw);
  }
}

function broadcastAdminState() {
  for (const [ws, conn] of connections) {
    if (conn.isAdmin && ws.readyState === 1) sendAdminState(ws);
  }
}

// ============================================================================
// START
// ============================================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Abod.io WebSocket server running on port ${PORT}`);
  console.log(`   HTTP status: http://localhost:${PORT}/status`);
  console.log(`   WebSocket:   ws://localhost:${PORT}`);
});
