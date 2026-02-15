// ============================================================================
// ABOD.IO — WebSocket Game Server
// Persistent process · Real-time push · Single game state
// ============================================================================
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3001;
const ADMIN_PW = process.env.ADMIN_PW || 'changeme';

// ---- Config ----
const DEFAULT_W = 4000, DEFAULT_H = 4000;
let W = DEFAULT_W, H = DEFAULT_H;
const FOOD_N = 300;
const SM = 10, SPLIT_MIN = 35, MAX_CELLS = 16, EAT_R = 1.25, BSPD = 5, MAX_MASS = 100000;
const PHASE_OUT_DEFAULT = 2.5; // seconds of invulnerability after join/respawn
const SPLIT_COOLDOWN_MS = 140;
const BG_MUSIC_MUTE = -1;
const BG_MUSIC_RANDOM = -2;
const MUSIC_TRACK_COUNT = 20;
const CLR = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9','#F8B500','#FF69B4'];
const FCLR = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F'];

// ---- Adjustable game settings (admin panel) ----
const gameConfig = {
  splitSpeed: 30,      // how fast split cells fly out (pixels/tick)
  splitDecel: 0.88,    // velocity decay per tick (lower = faster stop)
  wallKill: false,     // kill players touching walls
  mergeDelay: 10,      // seconds before split cells can merge (classic agar.io = 15, default = 10)
  decayRate: 0.9994,   // mass decay multiplier per tick for cells > 200
  decayMin: 200,       // mass threshold for decay
  gridW: DEFAULT_W,    // world width
  gridH: DEFAULT_H,    // world height
  gridCellSize: 50,    // grid line spacing
  virusCount: 8,       // number of viruses on the map
  virusMass: 100,      // mass of each virus
  ejectMass: 18,       // mass of ejected pellet
  ejectSpeed: 25,      // speed of ejected pellet
  ejectLoss: 18,       // mass lost when ejecting
  gameMode: 'default', // 'default' | 'laser' | 'azoz'
  laserCooldown: 3,    // seconds between laser shots
  laserDamage: 15,     // mass removed per laser hit
  laserRange: 400,     // max laser range in world units
  bgMusic: BG_MUSIC_RANDOM, // -2=random per join, -1=none, 0-19=fixed track
  // ---- Azoz Mode Config ----
  phaseOutTime: PHASE_OUT_DEFAULT, // seconds of invulnerability after join
  endGameMessage: 'You were eaten!', // default end game message (configurable)
  azozMapRatio: 1,           // x1: map adapt ratio (multiplier on total mass → world size)
  azozMaxFoodMass: 5000,     // x2: max mass reachable from regular food
  azozMushroomThreshold: 5000, // x3: min mass to consume red mushroom
  azozMushroomFlash: 5,      // x4: seconds before despawn to start flashing
  azozMushroomLifetime: 15,  // x5: seconds before mushroom despawns
  azozMushroomName: 'Red Mushroom', // x6: display name for special food
  redMushroom: false,        // x7: toggle red mushroom on/off (for non-azoz modes)
};

// ---- Grid Shapes (admin-drawn obstacles) ----
let gridShapes = []; // { type: 'rect'|'circle', x, y, w?, h?, r?, color }
const DEFAULT_GRID_CELL_SIZE = 50;

// ---- Red Mushrooms (Azoz Mode special food) ----
let mushrooms = []; // { id, x, y, spawnTime }
let mushroomVer = 0;

function spawnMushroom() {
  const p = rp(100);
  mushrooms.push({ id: uid(), x: p.x, y: p.y, spawnTime: Date.now() });
  mushroomVer++;
}

function tickMushrooms() {
  // Only active in azoz mode OR if redMushroom toggle is on
  const mushroomActive = gameConfig.gameMode === 'azoz' || gameConfig.redMushroom;
  if (!mushroomActive) {
    if (mushrooms.length > 0) { mushrooms = []; mushroomVer++; }
    return;
  }
  const now = Date.now();
  const lifetime = gameConfig.azozMushroomLifetime * 1000;
  // Remove expired mushrooms
  const before = mushrooms.length;
  mushrooms = mushrooms.filter(m => now - m.spawnTime < lifetime);
  if (mushrooms.length !== before) mushroomVer++;
  // Check if any player has reached threshold → spawn mushrooms occasionally
  let anyBig = false;
  for (const p of players.values()) {
    if (tmass(p.cells) >= gameConfig.azozMushroomThreshold) { anyBig = true; break; }
  }
  // Spawn mushrooms less frequently than regular food: max 3 on map at a time
  if (anyBig && mushrooms.length < 3 && Math.random() < 0.005) {
    spawnMushroom();
  }
}

// ---- Azoz Mode: Dynamic Map Sizing ----
let azozBaseW = DEFAULT_W, azozBaseH = DEFAULT_H;

function tickAzozMap() {
  if (gameConfig.gameMode !== 'azoz') return;
  let totalM = 0;
  for (const p of players.values()) totalM += tmass(p.cells);
  // Scale map based on total mass: base 4000 + ratio * sqrt(totalMass) * 10
  const scale = gameConfig.azozMapRatio * Math.sqrt(totalM) * 10;
  const newW = Math.max(2000, Math.min(20000, Math.round(azozBaseW + scale)));
  const newH = Math.max(2000, Math.min(20000, Math.round(azozBaseH + scale)));
  if (Math.abs(newW - W) > 50 || Math.abs(newH - H) > 50) {
    gameConfig.gridW = newW;
    gameConfig.gridH = newH;
    applyGridSize();
    broadcast(JSON.stringify({ t: 'gcfg', cfg: gameConfig, shapes: gridShapes }));
  }
}

function applyGridSize() {
  W = gameConfig.gridW;
  H = gameConfig.gridH;
  // Clamp all players and food to new bounds
  for (const p of players.values()) {
    for (const c of p.cells) {
      const r = rad(c.m);
      c.x = clp(c.x, r, Math.max(r, W - r));
      c.y = clp(c.y, r, Math.max(r, H - r));
    }
  }
  for (const f of food) {
    f.x = clp(f.x, 20, W - 20);
    f.y = clp(f.y, 20, H - 20);
  }
}

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
function sanitizeEndGameMessage(v) {
  if (typeof v !== 'string') return 'You were eaten!';
  const trimmed = v.trim().slice(0, 80);
  return trimmed || 'You were eaten!';
}
function resolveIntroTrack() {
  const track = Number(gameConfig.bgMusic);
  if (!Number.isFinite(track)) return BG_MUSIC_MUTE;
  if (track === BG_MUSIC_MUTE) return BG_MUSIC_MUTE;
  if (track === BG_MUSIC_RANDOM) return Math.floor(Math.random() * MUSIC_TRACK_COUNT);
  if (track >= 0 && track < MUSIC_TRACK_COUNT) return Math.floor(track);
  return BG_MUSIC_MUTE;
}

// ---- Game State ----
const players = new Map(); // id -> PlayerData
let food = [];
let viruses = [];
let foodVer = 0;
let virusVer = 0;
const kicked = new Map(); // lowercase name -> reason
let gen = 1;
let lastTick = Date.now();

// ---- Debug Stats ----
const dbg = { tickMs: 0, serMs: 0, payloadBytes: 0, playerCount: 0, cellCount: 0,
  foodEaten: 0, tickCount: 0, lastTickTime: 0, avgTickMs: 0, tickHistory: [] };

// ---- Activity Log ----
const activityLog = []; // { ts, type, name, device, ip }
let lastBroadcastEvLen = 0; // track what's been sent
function logActivity(type, name, device, ip) {
  activityLog.push({ ts: Date.now(), type, name, device: device || '', ip: ip || '' });
  if (activityLog.length > 200) {
    const trimmed = activityLog.length - 200;
    activityLog.splice(0, trimmed);
    lastBroadcastEvLen = Math.max(0, lastBroadcastEvLen - trimmed);
  }
}

// ---- Countdown / Announcement ----
let countdown = null; // { endsAt: timestamp, seconds: original }
let countdownInterval = null;
let serverPaused = false; // when true: no ticks, reject joins, disconnect players

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

// ---- Init Viruses ----
function initViruses() {
  viruses = [];
  for (let i = 0; i < gameConfig.virusCount; i++) {
    const p = rp(200);
    viruses.push({ id: uid(), x: p.x, y: p.y, m: gameConfig.virusMass });
  }
  virusVer++;
}
initViruses();

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
    // Apply split velocity to ALL cells (bots + humans)
    for (const cell of p.cells) {
      if (cell.vx || cell.vy) {
        cell.x += (cell.vx || 0) * dt;
        cell.y += (cell.vy || 0) * dt;
        cell.vx = (cell.vx || 0) * gameConfig.splitDecel;
        cell.vy = (cell.vy || 0) * gameConfig.splitDecel;
        if (Math.abs(cell.vx) < 0.5 && Math.abs(cell.vy) < 0.5) { cell.vx = 0; cell.vy = 0; }
      }
    }
    // Move bots only (human positions come from client)
    if (p.isBot) {
      for (const cell of p.cells) {
        const dx = p.mx - cell.x, dy = p.my - cell.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d > 5) { const s = spd(cell.m) * dt; cell.x += (dx / d) * s; cell.y += (dy / d) * s; }
      }
    }
    // Boundary + wall kill
    for (const cell of p.cells) {
      const r = rad(cell.m);
      if (gameConfig.wallKill) {
        if (cell.x - r < 0 || cell.x + r > W || cell.y - r < 0 || cell.y + r > H) {
          cell.m = 0; // mark for removal
        }
      }
      cell.x = clp(cell.x, r, Math.max(r, W - r));
      cell.y = clp(cell.y, r, Math.max(r, H - r));
    }
    // Remove dead cells from wall kill
    if (gameConfig.wallKill) {
      p.cells = p.cells.filter(c => c.m > 0);
    }
    // Merge/push own cells (with merge delay)
    for (let i = 0; i < p.cells.length; i++) {
      for (let j = i + 1; j < p.cells.length; j++) {
        const a = p.cells[i], b2 = p.cells[j], d = dst(a.x, a.y, b2.x, b2.y), md = rad(a.m) + rad(b2.m);
        const canMerge = gameConfig.mergeDelay <= 0 ||
          ((a.splitTime || 0) + gameConfig.mergeDelay * 1000 < Date.now() &&
           (b2.splitTime || 0) + gameConfig.mergeDelay * 1000 < Date.now());
        if (canMerge && d < md * 0.5 && p.cells.length > 1) { a.m += b2.m; p.cells.splice(j, 1); j--; continue; }
        if (d < md && d > 0.1) { const o = (md - d) / d * 0.5, px = (b2.x - a.x) * o, py = (b2.y - a.y) * o; a.x -= px; a.y -= py; b2.x += px; b2.y += py; }
      }
    }
    // Decay & mass cap
    const foodMassCap = (gameConfig.gameMode === 'azoz') ? gameConfig.azozMaxFoodMass : MAX_MASS;
    for (const cell of p.cells) {
      if (cell.m > gameConfig.decayMin) cell.m *= Math.pow(gameConfig.decayRate, dt);
      if (cell.m > MAX_MASS) cell.m = MAX_MASS;
    }
  }

  // ---- Move ejected food ----
  let foodChanged = false;
  for (const f of food) {
    if (f.ejVx || f.ejVy) {
      f.x += (f.ejVx || 0) * dt;
      f.y += (f.ejVy || 0) * dt;
      f.ejVx = (f.ejVx || 0) * 0.85;
      f.ejVy = (f.ejVy || 0) * 0.85;
      if (Math.abs(f.ejVx) < 0.3 && Math.abs(f.ejVy) < 0.3) { f.ejVx = 0; f.ejVy = 0; }
      f.x = clp(f.x, 5, W - 5);
      f.y = clp(f.y, 5, H - 5);
      foodChanged = true;
    }
  }

  // ---- Food collisions — BOTS ONLY ----
  let foodEatenThisTick = 0;
  const regFoodCap = (gameConfig.gameMode === 'azoz') ? gameConfig.azozMaxFoodMass : MAX_MASS;
  for (const p of players.values()) {
    if (!p.isBot) continue;
    for (const cell of p.cells) {
      const cr = rad(cell.m), crSq = cr * cr;
      for (let i = 0; i < food.length; i++) {
        const f = food[i], fdx = cell.x - f.x, fdy = cell.y - f.y;
        if (fdx * fdx + fdy * fdy < crSq) {
          // In Azoz mode, regular food can't push past azozMaxFoodMass
          if (cell.m >= regFoodCap) continue;
          cell.m += 1; foodEatenThisTick++;
          const np = rp(20); food[i] = { x: np.x, y: np.y, c: pick(FCLR) };
          foodChanged = true;
        }
      }
    }
  }
  if (foodChanged) foodVer++;
  dbg.foodEaten = foodEatenThisTick;

  // ---- Red Mushroom collisions — BOTS ONLY ----
  const mushroomActive = gameConfig.gameMode === 'azoz' || gameConfig.redMushroom;
  if (mushroomActive && mushrooms.length > 0) {
    for (const p of players.values()) {
      if (!p.isBot) continue;
      const pm = tmass(p.cells);
      if (pm < gameConfig.azozMushroomThreshold) continue;
      for (const cell of p.cells) {
        const cr = rad(cell.m);
        for (let mi = mushrooms.length - 1; mi >= 0; mi--) {
          const m = mushrooms[mi];
          const d = dst(cell.x, cell.y, m.x, m.y);
          if (d < cr) {
            cell.m += 200; // mushroom gives significant mass
            mushrooms.splice(mi, 1);
            mushroomVer++;
          }
        }
      }
    }
  }

  // ---- Virus collisions — all players ----
  let virusChanged = false;
  for (const p of players.values()) {
    for (const cell of p.cells) {
      for (let vi = viruses.length - 1; vi >= 0; vi--) {
        const v = viruses[vi];
        const d = dst(cell.x, cell.y, v.x, v.y);
        if (cell.m > v.m && d < rad(cell.m) - rad(v.m) * 0.4) {
          // Cell eats virus → split into many pieces
          cell.m += v.m;
          // Pop this cell into many small cells
          const pieces = Math.min(MAX_CELLS - p.cells.length, Math.floor(cell.m / SPLIT_MIN));
          if (pieces > 0) {
            const pieceM = Math.floor(cell.m / (pieces + 1));
            cell.m = pieceM;
            for (let pi = 0; pi < pieces; pi++) {
              const a = (Math.PI * 2 / pieces) * pi + Math.random() * 0.3;
              p.cells.push({
                id: uid(), x: cell.x, y: cell.y, m: pieceM, c: p.color,
                vx: Math.cos(a) * gameConfig.splitSpeed * 1.2,
                vy: Math.sin(a) * gameConfig.splitSpeed * 1.2,
                splitTime: Date.now(),
              });
            }
          }
          // Respawn virus elsewhere
          const np = rp(200);
          viruses[vi] = { id: uid(), x: np.x, y: np.y, m: gameConfig.virusMass };
          virusChanged = true;
        }
      }
    }
  }
  if (virusChanged) virusVer++;

  // ---- PvP (server-authoritative, disabled in laser mode) ----
  const all = [];
  for (const p of players.values()) for (const c of p.cells) all.push({ cell: c, p });
  const eaten = new Set();
  if (gameConfig.gameMode === 'laser') { /* no eating in laser mode */ } else {
  for (let i = 0; i < all.length; i++) {
    if (eaten.has(all[i].cell.id)) continue;
    for (let j = i + 1; j < all.length; j++) {
      if (eaten.has(all[j].cell.id)) continue;
      const { cell: c1, p: p1 } = all[i], { cell: c2, p: p2 } = all[j];
      if (p1.id === p2.id) continue;
      if ((p1.phaseOutUntil && now < p1.phaseOutUntil) || (p2.phaseOutUntil && now < p2.phaseOutUntil)) continue;
      const d = dst(c1.x, c1.y, c2.x, c2.y);
      if (c1.m > c2.m * EAT_R && d < rad(c1.m) - rad(c2.m) * 0.45) { c1.m += c2.m; p2.cells = p2.cells.filter(c => c.id !== c2.id); eaten.add(c2.id); }
      else if (c2.m > c1.m * EAT_R && d < rad(c2.m) - rad(c1.m) * 0.45) { c2.m += c1.m; p1.cells = p1.cells.filter(c => c.id !== c1.id); eaten.add(c1.id); break; }
    }
  }

  } // end PvP skip for laser mode

  // ---- Respawn dead players (bots auto-respawn, humans get death event) ----
  for (const p of players.values()) {
    if (p.cells.length === 0) {
      if (p.isBot) {
        // Bots auto-respawn
        const pos = rp();
        p.cells = [{ id: uid(), x: pos.x, y: pos.y, m: SM, c: p.color }];
        if (p.bot) { p.bot.tx = pos.x; p.bot.ty = pos.y; }
      } else if (!p.dead) {
        // Human died — send death event, don't respawn until they request it
        p.dead = true;
        p.deathTime = Date.now();
        for (const [ws, conn] of connections) {
          if (conn.playerId === p.id && ws.readyState === 1) {
            safeSend(ws, JSON.stringify({
              t: 'death',
              peak: p.peakMass || SM,
              timeAlive: Math.floor((Date.now() - (p.joinTime || Date.now())) / 1000),
              msg: gameConfig.endGameMessage,
            }));
          }
        }
      }
    }
  }

  // ---- Red Mushroom tick (spawn/despawn) ----
  tickMushrooms();

  // ---- Azoz Mode: dynamic map sizing ----
  tickAzozMap();
}

function doSplit(p) {
  if (p.cells.length >= MAX_CELLS) return;
  const news = [];
  const c = com(p.cells), ba = Math.atan2(p.my - c.y, p.mx - c.x);
  let canAdd = MAX_CELLS - p.cells.length;
  for (const cell of p.cells) {
    if (cell.m >= SPLIT_MIN && canAdd > 0) {
      const half = Math.floor(cell.m / 2); cell.m = half;
      const a = ba + (Math.random() - 0.5) * 0.5, r = rad(half);
      const spawnDist = r + 10;
      news.push({
        id: uid(), x: cell.x + Math.cos(a) * spawnDist, y: cell.y + Math.sin(a) * spawnDist,
        m: half, c: p.color,
        vx: Math.cos(a) * gameConfig.splitSpeed, vy: Math.sin(a) * gameConfig.splitSpeed,
        splitTime: Date.now(),
      });
      canAdd--;
    }
  }
  p.cells.push(...news);
}

function doEject(p) {
  const c = com(p.cells), ba = Math.atan2(p.my - c.y, p.mx - c.x);
  for (const cell of p.cells) {
    if (cell.m < gameConfig.ejectLoss + 10) continue; // need enough mass
    cell.m -= gameConfig.ejectLoss;
    const a = ba;
    // Spawn ejected mass as small food pellet moving outward
    const ex = cell.x + Math.cos(a) * (rad(cell.m) + 10);
    const ey = cell.y + Math.sin(a) * (rad(cell.m) + 10);
    food.push({ x: clp(ex, 20, W - 20), y: clp(ey, 20, H - 20), c: cell.c, ejVx: Math.cos(a) * gameConfig.ejectSpeed, ejVy: Math.sin(a) * gameConfig.ejectSpeed });
    foodVer++;
    break; // eject one per press
  }
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
function serMushrooms() { return mushrooms.map(m => [m.id, Math.round(m.x), Math.round(m.y), m.spawnTime]); }

// Safe send — prevents one bad connection from crashing broadcast loops
function safeSend(ws, data) {
  try { if (ws.readyState === 1) ws.send(data); }
  catch (_) { /* ignore send errors */ }
}

function broadcast(data) {
  for (const [cws] of connections) safeSend(cws, data);
}

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
    activity: activityLog.slice(-100),
    cfg: gameConfig,
    shapes: gridShapes,
    paused: serverPaused,
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
    res.end(JSON.stringify({ s: 'ok', h, b, paused: serverPaused }));
    return;
  }
  res.writeHead(404); res.end('Not Found');
});

// ============================================================================
// WEBSOCKET SERVER
// ============================================================================
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const conn = { playerId: null, isAdmin: false, ip };
  connections.set(ws, conn);

  ws.on('message', (raw) => {
    try { handleMessage(ws, conn, JSON.parse(raw.toString())); }
    catch (_) { /* ignore malformed */ }
  });

  ws.on('close', () => {
    if (conn.playerId) {
      const p = players.get(conn.playerId);
      if (p) logActivity('leave', p.name, p.device || '', conn.ip);
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
      if (serverPaused) { ws.send(JSON.stringify({ t: 'k', reason: 'Server is currently paused. Try again later.' })); return; }
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
      const p = {
        id, name, color, emoji, isBot: false, feedBonus: 0, cells: [cell],
        mx: pos.x, my: pos.y, lastPing: Date.now(), device,
        dead: false, deathTime: 0, joinTime: Date.now(), peakMass: SM, lastLaser: 0, lastSplitAt: 0,
        phaseOutUntil: Date.now() + ((gameConfig.phaseOutTime || PHASE_OUT_DEFAULT) * 1000),
      };
      players.set(id, p);
      conn.playerId = id;
      logActivity('join', name, device, conn.ip);
      const joinTrack = resolveIntroTrack();
      ws.send(JSON.stringify({
        t: 'w', id, mc: cell, w: W, h: H,
        f: serFood(), fv: foodVer, gen,
        p: serPlayers(), lb: mkLb(),
        cfg: gameConfig,
        shapes: gridShapes,
        v: viruses.map(v => [v.id, Math.round(v.x), Math.round(v.y), v.m]),
        mush: serMushrooms(), mushVer: mushroomVer,
        ev: activityLog.slice(-10).map(e => ({ ts: e.ts, type: e.type, name: e.name })),
        bgTrack: joinTrack,
      }));
      // Broadcast join music so everyone hears the same track.
      if (joinTrack >= 0) {
        broadcast(JSON.stringify({ t: 'playMusic', track: joinTrack }));
      }
      break;
    }
    // ---- Input (mouse + cells) ----
    case 'i': {
      const p = players.get(conn.playerId);
      if (!p || p.isBot) return;
      if (msg.x !== undefined) p.mx = msg.x;
      if (msg.y !== undefined) p.my = msg.y;
      if (Array.isArray(msg.cells)) {
        for (const cd of msg.cells) {
          const cell = p.cells.find(c => c.id === cd[0]);
          if (!cell) continue;
          if (typeof cd[1] === 'number') cell.x = cd[1];
          if (typeof cd[2] === 'number') cell.y = cd[2];
        }
        // Track peak mass
        const tm = tmass(p.cells);
        if (tm > (p.peakMass || 0)) p.peakMass = tm;
      }
      p.lastPing = Date.now();
      break;
    }
    // ---- Split ----
    case 's': {
      const p = players.get(conn.playerId);
      if (p && !p.dead && p.cells.length > 0) {
        p.lastPing = Date.now();
        const now = Date.now();
        if (now - (p.lastSplitAt || 0) >= SPLIT_COOLDOWN_MS) {
          p.lastSplitAt = now;
          doSplit(p);
        }
      }
      break;
    }
    // ---- Eject Mass ----
    case 'w': {
      const p = players.get(conn.playerId);
      if (p) { p.lastPing = Date.now(); doEject(p); }
      break;
    }
    // ---- Leave ----
    case 'l': {
      if (conn.playerId) {
        const p = players.get(conn.playerId);
        if (p) logActivity('leave', p.name, p.device || '', conn.ip);
        players.delete(conn.playerId);
        conn.playerId = null;
      }
      break;
    }
    // ---- Respawn (after death screen) ----
    case 'respawn': {
      const p = players.get(conn.playerId);
      if (!p || p.isBot) return;
      if (p.dead && p.cells.length === 0) {
        const pos = rp();
        p.cells = [{ id: uid(), x: pos.x, y: pos.y, m: SM, c: p.color }];
        p.dead = false;
        p.joinTime = Date.now();
        p.peakMass = SM;
        p.lastLaser = 0;
        p.lastSplitAt = 0;
        p.phaseOutUntil = Date.now() + ((gameConfig.phaseOutTime || PHASE_OUT_DEFAULT) * 1000);
      }
      break;
    }
    // ---- Laser (laser mode only) ----
    case 'laser': {
      if (gameConfig.gameMode !== 'laser') return;
      const p = players.get(conn.playerId);
      if (!p || p.isBot || p.cells.length === 0) return;
      const now = Date.now();
      if (now - (p.lastLaser || 0) < gameConfig.laserCooldown * 1000) return;
      p.lastLaser = now;
      // Calculate laser line from player center toward angle
      const c = com(p.cells);
      const angle = typeof msg.angle === 'number' ? msg.angle : 0;
      const range = gameConfig.laserRange;
      const ex = c.x + Math.cos(angle) * range;
      const ey = c.y + Math.sin(angle) * range;
      // Check hits against all other players
      const hits = [];
      for (const [vid, vp] of players) {
        if (vid === p.id) continue;
        for (const cell of vp.cells) {
          // Point-to-segment distance check
          const cr = rad(cell.m);
          const dx = ex - c.x, dy = ey - c.y;
          const fx = c.x - cell.x, fy = c.y - cell.y;
          const a2 = dx * dx + dy * dy;
          const b2 = 2 * (fx * dx + fy * dy);
          const c2 = fx * fx + fy * fy - cr * cr;
          let disc = b2 * b2 - 4 * a2 * c2;
          if (disc >= 0) {
            disc = Math.sqrt(disc);
            const t1 = (-b2 - disc) / (2 * a2);
            const t2 = (-b2 + disc) / (2 * a2);
            if ((t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1) || (t1 < 0 && t2 > 1)) {
              // Hit! Remove mass
              const dmg = Math.min(cell.m - 1, gameConfig.laserDamage);
              cell.m -= dmg;
              hits.push({ pid: vid, cid: cell.id, dmg });
            }
          }
        }
      }
      // Broadcast laser visual to all players
      broadcast(JSON.stringify({
        t: 'laser',
        from: { x: Math.round(c.x), y: Math.round(c.y) },
        to: { x: Math.round(ex), y: Math.round(ey) },
        color: p.color,
        pid: p.id,
        hits: hits.length,
      }));
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
    // ---- Admin Pause / Resume ----
    case 'apause': {
      if (!conn.isAdmin) return;
      serverPaused = !!msg.paused;
      if (serverPaused) {
        // Kick all non-admin players and bots
        for (const [ows, oc] of connections) {
          if (oc.playerId && !oc.isAdmin && ows.readyState === 1) {
            ows.send(JSON.stringify({ t: 'k', reason: 'Server has been paused by admin.' }));
          }
        }
        // Remove all players (bots + humans)
        players.clear();
      }
      ws.send(JSON.stringify({ t: 'am', ok: 1, action: 'admin_pause' }));
      break;
    }
    // ---- Admin Reset ----
    case 'ar': {
      if (!conn.isAdmin) return;
      players.clear(); kicked.clear(); initFood(); initViruses(); gen++;
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
        dead: false, deathTime: 0, joinTime: Date.now(), peakMass: botMass, lastLaser: 0, lastSplitAt: 0, phaseOutUntil: 0,
        bot: { tx: pos.x, ty: pos.y, rt: Date.now() + 1000, scd: Date.now() + 5000 },
      });
      ws.send(JSON.stringify({ t: 'am', ok: 1, action: 'admin_add_bot', botId }));
      break;
    }
    // ---- Admin Rename ----
    case 'arn': {
      if (!conn.isAdmin) return;
      const rp = players.get(msg.pid);
      if (rp && msg.newName && typeof msg.newName === 'string') {
        rp.name = msg.newName.slice(0, 20);
      }
      ws.send(JSON.stringify({ t: 'am', ok: 1, action: 'admin_rename' }));
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
    // ---- Admin Config Update ----
    case 'acfg': {
      if (!conn.isAdmin) return;
      const allowed = ['splitSpeed','splitDecel','wallKill','mergeDelay','decayRate','decayMin',
        'virusCount','virusMass','ejectMass','ejectSpeed','ejectLoss',
        'gameMode','laserCooldown','laserDamage','laserRange','bgMusic',
        'azozMapRatio','azozMaxFoodMass','azozMushroomThreshold','azozMushroomFlash',
        'azozMushroomLifetime','azozMushroomName','redMushroom',
        'phaseOutTime','endGameMessage'];
      const oldVC = gameConfig.virusCount, oldVM = gameConfig.virusMass;
      for (const k of allowed) {
        if (msg[k] === undefined) continue;
        if (k === 'phaseOutTime') {
          const v = Number(msg[k]);
          if (Number.isFinite(v)) gameConfig.phaseOutTime = clp(v, 0, 20);
          continue;
        }
        if (k === 'endGameMessage') {
          gameConfig.endGameMessage = sanitizeEndGameMessage(msg[k]);
          continue;
        }
        if (k === 'bgMusic') {
          const v = Math.floor(Number(msg[k]));
          if (Number.isFinite(v)) gameConfig.bgMusic = clp(v, BG_MUSIC_RANDOM, MUSIC_TRACK_COUNT - 1);
          continue;
        }
        gameConfig[k] = msg[k];
      }
      // Re-init viruses only if count or mass actually changed
      if (gameConfig.virusCount !== oldVC || gameConfig.virusMass !== oldVM) {
        initViruses();
      }
      // Track Azoz base dimensions when switching to azoz mode
      if (gameConfig.gameMode === 'azoz') {
        azozBaseW = DEFAULT_W;
        azozBaseH = DEFAULT_H;
      }
      // Broadcast new config to all players
      broadcast(JSON.stringify({ t: 'cfg', cfg: gameConfig }));
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'admin_config' }));
      break;
    }
    // ---- Admin Grid Update (size + shapes) ----
    case 'agrid': {
      if (!conn.isAdmin) return;
      // Update grid dimensions
      if (typeof msg.gridW === 'number') gameConfig.gridW = clp(msg.gridW, 500, 20000);
      if (typeof msg.gridH === 'number') gameConfig.gridH = clp(msg.gridH, 500, 20000);
      if (typeof msg.gridCellSize === 'number') gameConfig.gridCellSize = clp(msg.gridCellSize, 10, 500);
      applyGridSize();
      // Update shapes if provided
      if (Array.isArray(msg.shapes)) {
        gridShapes = msg.shapes.filter(s => s && (s.type === 'rect' || s.type === 'circle') &&
          typeof s.x === 'number' && typeof s.y === 'number').slice(0, 50);
      }
      // Broadcast to all players
      broadcast(JSON.stringify({ t: 'gcfg', cfg: gameConfig, shapes: gridShapes }));
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'admin_grid' }));
      break;
    }
    // ---- Admin Grid Reset ----
    case 'agrr': {
      if (!conn.isAdmin) return;
      gameConfig.gridW = DEFAULT_W;
      gameConfig.gridH = DEFAULT_H;
      gameConfig.gridCellSize = DEFAULT_GRID_CELL_SIZE;
      gridShapes = [];
      applyGridSize();
      broadcast(JSON.stringify({ t: 'gcfg', cfg: gameConfig, shapes: gridShapes }));
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'admin_grid_reset' }));
      break;
    }
    // ---- Admin Countdown / Announce Reset ----
    case 'acd': {
      if (!conn.isAdmin) return;
      const secs = Math.max(5, Math.min(msg.seconds || 30, 300));
      countdown = { endsAt: Date.now() + secs * 1000, seconds: secs };
      // Clear any existing countdown interval
      if (countdownInterval) clearInterval(countdownInterval);
      // Broadcast countdown tick every second
      countdownInterval = setInterval(() => {
        if (!countdown) { clearInterval(countdownInterval); countdownInterval = null; return; }
        const remaining = Math.max(0, Math.ceil((countdown.endsAt - Date.now()) / 1000));
        const cdMsg = JSON.stringify({ t: 'cd', remaining });
        broadcast(cdMsg);
        if (remaining <= 0) {
          clearInterval(countdownInterval);
          countdownInterval = null;
          countdown = null;
          // Reset the server
          players.clear(); kicked.clear(); initFood(); initViruses(); gen++;
          broadcast(JSON.stringify({ t: 'cd', remaining: 0, reset: true }));
        }
      }, 1000);
      // Send immediate first tick
      broadcast(JSON.stringify({ t: 'cd', remaining: secs }));
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'admin_countdown' }));
      break;
    }
    // ---- Admin Cancel Countdown ----
    case 'acdc': {
      if (!conn.isAdmin) return;
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
      countdown = null;
      broadcast(JSON.stringify({ t: 'cd', remaining: -1 }));
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'admin_cancel_countdown' }));
      break;
    }
    // ---- Client Eat Report ----
    case 'e': {
      // Deprecated: server resolves PvP in tick() for precision.
      break;
    }
    // ---- Client Mushroom Eat Report ----
    case 'me': {
      if (!conn.playerId) return;
      const p = players.get(conn.playerId);
      if (!p || p.isBot) return;
      const pm = tmass(p.cells);
      if (pm < gameConfig.azozMushroomThreshold) return;
      const mid = msg.mid; // mushroom id
      const idx = mushrooms.findIndex(m => m.id === mid);
      if (idx !== -1) {
        // Give mass to the reporting player's largest cell
        const largest = p.cells.reduce((a, b) => a.m > b.m ? a : b);
        largest.m += 200;
        mushrooms.splice(idx, 1);
        mushroomVer++;
      }
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
let lastBroadcastVv = -1;
let lastBroadcastMv = -1;

setInterval(() => {
  if (serverPaused) return; // skip everything when paused
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
  // Include viruses when changed
  if (virusVer !== lastBroadcastVv) {
    state.v = viruses.map(v => [v.id, Math.round(v.x), Math.round(v.y), v.m]);
    lastBroadcastVv = virusVer;
  }
  // Include mushrooms when changed
  if (mushroomVer !== lastBroadcastMv) {
    state.mush = serMushrooms();
    state.mushVer = mushroomVer;
    lastBroadcastMv = mushroomVer;
  }
  // Include new activity events since last broadcast (strip IP for game clients)
  if (activityLog.length > lastBroadcastEvLen) {
    state.ev = activityLog.slice(lastBroadcastEvLen).map(e => ({ ts: e.ts, type: e.type, name: e.name }));
    lastBroadcastEvLen = activityLog.length;
  }
  const raw = JSON.stringify(state);
  dbg.payloadBytes = raw.length;
  for (const [ws, conn] of connections) {
    if (conn.playerId) safeSend(ws, raw);
  }
}

function broadcastAdminState() {
  for (const [ws, conn] of connections) {
    if (conn.isAdmin && ws.readyState === 1) {
      try { sendAdminState(ws); } catch (_) { /* ignore */ }
    }
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
