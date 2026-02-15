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
const MUSIC_TRACK_COUNT = 50;
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
  laserLength: 400,    // max beam length in world units
  laserWidth: 8,       // beam width in world units
  laserCellKill: false, // laser hit kills touched cell; main hit kills whole player
  bgMusic: BG_MUSIC_RANDOM, // -2=random per join, -1=none, 0-49=fixed track
  movementStyle: 'pointer', // 'pointer' | 'lastDirection' | 'screenOffset'
  mobileControlMode: 'classic', // 'classic' | 'landscape' (touch devices only)
  voiceChatEnabled: false, // enable voice chat relay for connected players
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
let gridShapes = []; // { type, x, y, ... }
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

function sanitizeGridShape(shape) {
  if (!shape || typeof shape !== 'object') return null;
  const x = Number(shape.x), y = Number(shape.y);
  const color = (typeof shape.color === 'string' && shape.color.length <= 20) ? shape.color : '#ffffff';
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const type = String(shape.type || '');
  if (type === 'rect') {
    const w = Number(shape.w), h = Number(shape.h);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
    return { type: 'rect', x, y, w: clp(w, 10, 5000), h: clp(h, 10, 5000), color };
  }
  if (type === 'circle') {
    const r = Number(shape.r);
    if (!Number.isFinite(r)) return null;
    return { type: 'circle', x, y, r: clp(r, 10, 3000), color };
  }
  if (type === 'ellipse') {
    const rx = Number(shape.rx), ry = Number(shape.ry);
    if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
    return { type: 'ellipse', x, y, rx: clp(rx, 10, 4000), ry: clp(ry, 10, 4000), color };
  }
  if (type === 'triangle') {
    const size = Number(shape.size);
    if (!Number.isFinite(size)) return null;
    return { type: 'triangle', x, y, size: clp(size, 10, 4000), color };
  }
  return null;
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
// SURVIVAL GAMES (Mineplex-inspired mode)
// ============================================================================
const SG_W = 5200;
const SG_H = 5200;
const SG_CENTER = { x: SG_W / 2, y: SG_H / 2 };
const SG_MAX_HP = 100;
const SG_IDLE_TIMEOUT_MS = 30000;

const sgConfig = {
  minPlayersToStart: 2,
  countdownSec: 12,
  graceSec: 20,
  matchDurationSec: 480,
  moveSpeed: 340, // units per second
  attackCooldownMs: 700,
  attackRange: 130,
  baseDamage: 22,
  soupHeal: 32,
  compassCooldownSec: 10,
  invisDurationSec: 6,
  invisCooldownSec: 35,
  speedBoostMultiplier: 1.55,
  speedBoostDurationSec: 6,
  speedBoostCooldownSec: 30,
  chestTier2Chance: 0.32,
  chestTier3Chance: 0.12,
  borderStartRadius: 2300,
  borderEndRadius: 500,
  borderShrinkDelaySec: 90,
  borderShrinkDurationSec: 240,
  borderDamagePerSec: 16,
  chestOpenRange: 95,
  chestRefillSec: 75,
  weaponMaxTier: 4,
  armorMaxTier: 3,
  lateJoinAsSpectator: true,
  autoResetSec: 12,
};

const sgPlayers = new Map(); // id -> SGPlayer
let sgGen = 1;
let sgLastTick = Date.now();
let sgChestVer = 0;
let sgLastEventBroadcastLen = 0;
const sgEvents = []; // { ts, type, msg }
const sgMatch = {
  phase: 'lobby', // lobby | countdown | running | ended
  countdownEndsAt: 0,
  startedAt: 0,
  endsAt: 0,
  endedAt: 0,
  winnerId: null,
  endReason: '',
  borderRadius: 2300,
};

const SG_CHEST_POINTS = [
  { x: 2600, y: 2600 }, { x: 2600, y: 900 }, { x: 2600, y: 4300 }, { x: 900, y: 2600 }, { x: 4300, y: 2600 },
  { x: 1350, y: 1350 }, { x: 3850, y: 1350 }, { x: 1350, y: 3850 }, { x: 3850, y: 3850 },
  { x: 2600, y: 1400 }, { x: 2600, y: 3800 }, { x: 1400, y: 2600 }, { x: 3800, y: 2600 },
  { x: 1000, y: 1700 }, { x: 1700, y: 1000 }, { x: 4200, y: 1700 }, { x: 3500, y: 1000 },
  { x: 1000, y: 3500 }, { x: 1700, y: 4200 }, { x: 4200, y: 3500 }, { x: 3500, y: 4200 },
];
let sgChests = [];

function sgLog(type, msg) {
  sgEvents.push({ ts: Date.now(), type, msg: String(msg || '').slice(0, 140) });
  if (sgEvents.length > 200) {
    const trimmed = sgEvents.length - 200;
    sgEvents.splice(0, trimmed);
    sgLastEventBroadcastLen = Math.max(0, sgLastEventBroadcastLen - trimmed);
  }
}

function initSurvivalChests() {
  sgChests = SG_CHEST_POINTS.map((p, i) => ({
    id: `c-${i}`,
    x: p.x,
    y: p.y,
    openedAt: 0,
    nextRefillAt: 0,
  }));
  sgChestVer++;
}
initSurvivalChests();

function sgAlivePlayers() {
  const out = [];
  for (const p of sgPlayers.values()) {
    if (!p.spectator && p.alive) out.push(p);
  }
  return out;
}

function sgActivePlayers() {
  const out = [];
  for (const p of sgPlayers.values()) {
    if (!p.spectator) out.push(p);
  }
  return out;
}

function sgClampPos(p) {
  p.x = clp(p.x, 20, SG_W - 20);
  p.y = clp(p.y, 20, SG_H - 20);
}

function sgPickSpawn() {
  const alive = sgAlivePlayers();
  let best = null;
  for (let i = 0; i < 24; i++) {
    const a = (Math.PI * 2 * i) / 24;
    const r = 1800;
    const candidate = { x: SG_CENTER.x + Math.cos(a) * r, y: SG_CENTER.y + Math.sin(a) * r };
    let minD = Infinity;
    for (const p of alive) minD = Math.min(minD, dst(candidate.x, candidate.y, p.x, p.y));
    if (!best || minD > best.minD) best = { ...candidate, minD };
  }
  return best ? { x: best.x, y: best.y } : { x: SG_CENTER.x, y: SG_CENTER.y };
}

function sgResetPlayerForRound(p) {
  const spawn = sgPickSpawn();
  p.x = spawn.x;
  p.y = spawn.y;
  p.mx = 0;
  p.my = 0;
  p.face = 0;
  p.alive = true;
  p.spectator = false;
  p.hp = SG_MAX_HP;
  p.weaponTier = 0;
  p.armorTier = 0;
  p.soups = 1;
  p.compassCharges = 1;
  p.sneakyCharges = 1;
  p.weightlessCharges = 1;
  p.invulnUntil = Date.now() + 1200;
  p.invisUntil = 0;
  p.speedUntil = 0;
  p.hitGlowUntil = 0;
  p.nextCompassAt = 0;
  p.nextSneakyAt = 0;
  p.nextWeightlessAt = 0;
  p.lastAttack = 0;
}

function sgSetSpectator(p) {
  p.x = SG_CENTER.x;
  p.y = SG_CENTER.y;
  p.mx = 0;
  p.my = 0;
  p.face = 0;
  p.alive = false;
  p.spectator = true;
  p.hp = 0;
  p.weaponTier = 0;
  p.armorTier = 0;
  p.soups = 0;
  p.compassCharges = 0;
  p.sneakyCharges = 0;
  p.weightlessCharges = 0;
  p.invulnUntil = 0;
  p.invisUntil = 0;
  p.speedUntil = 0;
  p.hitGlowUntil = 0;
  p.nextCompassAt = 0;
  p.nextSneakyAt = 0;
  p.nextWeightlessAt = 0;
}

function sgResetRound(keepPlayers = true) {
  sgMatch.phase = 'lobby';
  sgMatch.countdownEndsAt = 0;
  sgMatch.startedAt = 0;
  sgMatch.endsAt = 0;
  sgMatch.endedAt = 0;
  sgMatch.winnerId = null;
  sgMatch.endReason = '';
  sgMatch.borderRadius = sgConfig.borderStartRadius;
  sgGen++;
  initSurvivalChests();
  if (!keepPlayers) {
    sgPlayers.clear();
    return;
  }
  for (const p of sgPlayers.values()) sgResetPlayerForRound(p);
}

function sgStartCountdown() {
  if (sgMatch.phase !== 'lobby') return;
  sgMatch.phase = 'countdown';
  sgMatch.countdownEndsAt = Date.now() + sgConfig.countdownSec * 1000;
  sgLog('system', `Survival Games starts in ${sgConfig.countdownSec}s`);
}

function sgStartMatch() {
  sgMatch.phase = 'running';
  sgMatch.startedAt = Date.now();
  sgMatch.endsAt = sgMatch.startedAt + sgConfig.matchDurationSec * 1000;
  sgMatch.endedAt = 0;
  sgMatch.winnerId = null;
  sgMatch.endReason = '';
  sgMatch.borderRadius = sgConfig.borderStartRadius;
  for (const p of sgPlayers.values()) {
    if (!p.spectator) sgResetPlayerForRound(p);
    else sgSetSpectator(p);
  }
  sgLog('system', 'Survival Games match started');
}

function sgEndMatch(winnerId, reason) {
  if (sgMatch.phase === 'ended') return;
  sgMatch.phase = 'ended';
  sgMatch.endedAt = Date.now();
  sgMatch.winnerId = winnerId || null;
  sgMatch.endReason = String(reason || '').slice(0, 60);
  if (winnerId && sgPlayers.has(winnerId)) {
    sgLog('system', `Winner: ${sgPlayers.get(winnerId).name}`);
  } else {
    sgLog('system', 'Match ended with no winner');
  }
}

function sgUpdateBorder(now) {
  if (sgMatch.phase !== 'running') return;
  const elapsed = (now - sgMatch.startedAt) / 1000;
  const startR = Math.max(300, Number(sgConfig.borderStartRadius) || 2300);
  const endR = Math.max(120, Math.min(startR, Number(sgConfig.borderEndRadius) || 500));
  const delay = Math.max(0, Number(sgConfig.borderShrinkDelaySec) || 0);
  const duration = Math.max(1, Number(sgConfig.borderShrinkDurationSec) || 1);
  if (elapsed <= delay) {
    sgMatch.borderRadius = startR;
    return;
  }
  if (elapsed >= delay + duration) {
    sgMatch.borderRadius = endR;
    return;
  }
  const t = (elapsed - delay) / duration;
  sgMatch.borderRadius = startR + (endR - startR) * t;
}

function sgKillPlayer(victim, killer, cause) {
  if (!victim.alive) return;
  victim.alive = false;
  victim.hp = 0;
  victim.invisUntil = 0;
  victim.speedUntil = 0;
  victim.deaths = (victim.deaths || 0) + 1;
  if (killer && killer.id !== victim.id) killer.kills = (killer.kills || 0) + 1;
  const by = killer && killer.id !== victim.id ? `${killer.name}` : 'Environment';
  sgLog('death', `${victim.name} was eliminated by ${by}${cause ? ` (${cause})` : ''}`);
}

function sgFindNearestEnemy(player) {
  if (!player || !player.alive || player.spectator) return null;
  let best = null;
  let bestDist = Infinity;
  for (const p of sgPlayers.values()) {
    if (p.id === player.id || !p.alive || p.spectator) continue;
    const d = dst(player.x, player.y, p.x, p.y);
    if (d < bestDist) { best = p; bestDist = d; }
  }
  return best ? { target: best, dist: bestDist } : null;
}

function sgTryCompass(player, ws) {
  const now = Date.now();
  if (!player || !player.alive || player.spectator) return false;
  if ((player.compassCharges || 0) <= 0) return false;
  if (now < (player.nextCompassAt || 0)) return false;
  const nearest = sgFindNearestEnemy(player);
  if (!nearest) return false;

  player.compassCharges = Math.max(0, (player.compassCharges || 0) - 1);
  player.nextCompassAt = now + Math.max(1, sgConfig.compassCooldownSec) * 1000;
  const bearing = Math.atan2(nearest.target.y - player.y, nearest.target.x - player.x);
  safeSend(ws, JSON.stringify({
    t: 'sgcompass',
    target: nearest.target.name,
    distance: Math.round(nearest.dist),
    bearing,
    expiresIn: 5,
  }));
  sgLog('info', `${player.name} used tracking compass`);
  return true;
}

function sgTrySoup(player) {
  if (!player || !player.alive || player.spectator) return false;
  if ((player.soups || 0) <= 0) return false;
  if (player.hp >= SG_MAX_HP) return false;
  player.soups--;
  player.hp = clp(player.hp + (Number(sgConfig.soupHeal) || 32), 1, SG_MAX_HP);
  sgLog('loot', `${player.name} consumed soup`);
  return true;
}

function sgTryAbility(player, ability) {
  const now = Date.now();
  if (!player || !player.alive || player.spectator) return false;

  if (ability === 'sneaky') {
    if ((player.sneakyCharges || 0) <= 0) return false;
    if (now < (player.nextSneakyAt || 0)) return false;
    player.sneakyCharges--;
    player.invisUntil = now + Math.max(1, Number(sgConfig.invisDurationSec) || 6) * 1000;
    player.nextSneakyAt = now + Math.max(1, Number(sgConfig.invisCooldownSec) || 35) * 1000;
    sgLog('ability', `${player.name} activated Sneaky`);
    return true;
  }

  if (ability === 'weightless') {
    if ((player.weightlessCharges || 0) <= 0) return false;
    if (now < (player.nextWeightlessAt || 0)) return false;
    player.weightlessCharges--;
    player.speedUntil = now + Math.max(1, Number(sgConfig.speedBoostDurationSec) || 6) * 1000;
    player.nextWeightlessAt = now + Math.max(1, Number(sgConfig.speedBoostCooldownSec) || 30) * 1000;
    sgLog('ability', `${player.name} activated Weightless`);
    return true;
  }

  return false;
}

function sgTryAttack(attacker) {
  const now = Date.now();
  if (sgMatch.phase !== 'running') return;
  if (!attacker || !attacker.alive || attacker.spectator) return;
  if (now < (attacker.invisUntil || 0)) attacker.invisUntil = 0; // attacking breaks invis
  if (now < attacker.invulnUntil) return;
  if (now - (attacker.lastAttack || 0) < sgConfig.attackCooldownMs) return;
  if (now < sgMatch.startedAt + sgConfig.graceSec * 1000) return;
  attacker.lastAttack = now;

  const range = Math.max(40, Number(sgConfig.attackRange) || 130);
  let target = null;
  let best = Infinity;
  for (const p of sgPlayers.values()) {
    if (p.id === attacker.id || !p.alive || p.spectator) continue;
    if (now < p.invulnUntil) continue;
    const d = dst(attacker.x, attacker.y, p.x, p.y);
    if (d < range && d < best) { best = d; target = p; }
  }
  if (!target) return;

  const raw = (Number(sgConfig.baseDamage) || 22) + attacker.weaponTier * 7 - target.armorTier * 5;
  const dmg = clp(raw, 5, 80);
  target.hp -= dmg;
  target.hitGlowUntil = now + 900;
  if (target.hp <= 0) sgKillPlayer(target, attacker, 'melee');
}

function sgTryOpenChest(player) {
  const now = Date.now();
  if (!player || !player.alive || player.spectator) return false;
  const openRange = Math.max(30, Number(sgConfig.chestOpenRange) || 95);
  let chest = null;
  let best = Infinity;
  for (const c of sgChests) {
    if (c.openedAt && now < c.nextRefillAt) continue;
    const d = dst(player.x, player.y, c.x, c.y);
    if (d < openRange && d < best) { best = d; chest = c; }
  }
  if (!chest) return false;

  chest.openedAt = now;
  chest.nextRefillAt = now + Math.max(10, Number(sgConfig.chestRefillSec) || 75) * 1000;
  sgChestVer++;

  const distToCenter = dst(chest.x, chest.y, SG_CENTER.x, SG_CENTER.y);
  const centerBias = distToCenter < 550 ? 0.2 : distToCenter < 1200 ? 0.08 : 0;
  const tier3Chance = clp((Number(sgConfig.chestTier3Chance) || 0.12) + centerBias, 0, 0.95);
  const tier2Chance = clp((Number(sgConfig.chestTier2Chance) || 0.32) + centerBias * 0.8, 0, 0.95);
  const roll = Math.random();
  const tier = roll < tier3Chance ? 3 : roll < tier3Chance + tier2Chance ? 2 : 1;

  const lootSummary = [];
  const heal = 6 + Math.floor(Math.random() * 10) + tier * 4;
  player.hp = clp(player.hp + heal, 1, SG_MAX_HP);
  lootSummary.push(`+${heal}HP`);

  if (Math.random() < (tier === 3 ? 0.9 : tier === 2 ? 0.65 : 0.42)) {
    const prev = player.weaponTier || 0;
    player.weaponTier = clp(prev + 1, 0, sgConfig.weaponMaxTier);
    if (player.weaponTier > prev) lootSummary.push(`⚔️${player.weaponTier}`);
  }
  if (Math.random() < (tier === 3 ? 0.78 : tier === 2 ? 0.52 : 0.34)) {
    const prev = player.armorTier || 0;
    player.armorTier = clp(prev + 1, 0, sgConfig.armorMaxTier);
    if (player.armorTier > prev) lootSummary.push(`🛡️${player.armorTier}`);
  }

  if (Math.random() < (tier >= 2 ? 0.72 : 0.46)) {
    const gain = tier === 3 ? 2 : 1;
    player.soups = clp((player.soups || 0) + gain, 0, 8);
    lootSummary.push(`🍲+${gain}`);
  }
  if (Math.random() < (tier >= 2 ? 0.6 : 0.28)) {
    const gain = tier === 3 ? 2 : 1;
    player.compassCharges = clp((player.compassCharges || 0) + gain, 0, 8);
    lootSummary.push(`🧭+${gain}`);
  }
  if (Math.random() < (tier === 3 ? 0.42 : 0.16)) {
    player.sneakyCharges = clp((player.sneakyCharges || 0) + 1, 0, 5);
    lootSummary.push('🫥+1');
  }
  if (Math.random() < (tier === 3 ? 0.42 : 0.16)) {
    player.weightlessCharges = clp((player.weightlessCharges || 0) + 1, 0, 5);
    lootSummary.push('💨+1');
  }

  sgLog('loot', `${player.name} looted T${tier} chest (${lootSummary.join(' ')})`);
  return true;
}

function sgTick() {
  const now = Date.now();
  let dms = now - sgLastTick;
  if (dms < 15) return;
  if (dms > 500) dms = 500;
  sgLastTick = now;
  const dtSec = dms / 1000;

  // Remove stale/idle players.
  for (const [id, p] of sgPlayers) {
    if (now - (p.lastPing || now) > SG_IDLE_TIMEOUT_MS) {
      sgPlayers.delete(id);
      sgLog('leave', `${p.name} timed out`);
    }
  }

  // Refill chests.
  for (const c of sgChests) {
    if (c.openedAt && now >= c.nextRefillAt) {
      c.openedAt = 0;
      c.nextRefillAt = 0;
      sgChestVer++;
    }
  }

  const activePlayers = sgActivePlayers();
  if (sgMatch.phase === 'lobby') {
    if (activePlayers.length >= sgConfig.minPlayersToStart) sgStartCountdown();
  } else if (sgMatch.phase === 'countdown') {
    if (activePlayers.length < sgConfig.minPlayersToStart) {
      sgMatch.phase = 'lobby';
      sgMatch.countdownEndsAt = 0;
      sgLog('system', 'Countdown cancelled: not enough players');
    } else if (now >= sgMatch.countdownEndsAt) {
      sgStartMatch();
    }
  } else if (sgMatch.phase === 'running') {
    sgUpdateBorder(now);

    // Move players and apply border damage.
    for (const p of sgPlayers.values()) {
      if (!p.alive || p.spectator) continue;
      const mag = Math.hypot(p.mx || 0, p.my || 0);
      if (mag > 1e-3) {
        const nx = (p.mx || 0) / mag;
        const ny = (p.my || 0) / mag;
        const speedBoostActive = now < (p.speedUntil || 0);
        const speedMult = speedBoostActive ? (Number(sgConfig.speedBoostMultiplier) || 1.55) : 1;
        p.x += nx * sgConfig.moveSpeed * speedMult * dtSec;
        p.y += ny * sgConfig.moveSpeed * speedMult * dtSec;
      }
      sgClampPos(p);
      const dd = dst(p.x, p.y, SG_CENTER.x, SG_CENTER.y);
      if (dd > sgMatch.borderRadius) {
        p.hp -= sgConfig.borderDamagePerSec * dtSec;
        if (p.hp <= 0) sgKillPlayer(p, null, 'border');
      }
    }

    const alive = sgAlivePlayers();
    if (alive.length <= 1) {
      sgEndMatch(alive[0] ? alive[0].id : null, 'last-alive');
    } else if (now >= sgMatch.endsAt) {
      const ranked = [...alive].sort((a, b) => (b.kills - a.kills) || (b.hp - a.hp));
      sgEndMatch(ranked[0] ? ranked[0].id : null, 'time');
    }
  } else if (sgMatch.phase === 'ended') {
    if (now - sgMatch.endedAt >= Math.max(5, sgConfig.autoResetSec) * 1000) {
      sgResetRound(true);
    }
  }
}

function sgMatchPayload() {
  const now = Date.now();
  const graceRemaining = sgMatch.phase === 'running'
    ? Math.max(0, Math.ceil((sgMatch.startedAt + sgConfig.graceSec * 1000 - now) / 1000))
    : 0;
  const countdownRemaining = sgMatch.phase === 'countdown'
    ? Math.max(0, Math.ceil((sgMatch.countdownEndsAt - now) / 1000))
    : 0;
  const endRemaining = sgMatch.phase === 'running'
    ? Math.max(0, Math.ceil((sgMatch.endsAt - now) / 1000))
    : 0;
  return {
    phase: sgMatch.phase,
    countdownRemaining,
    graceRemaining,
    endRemaining,
    borderRadius: Math.round(sgMatch.borderRadius),
    winnerId: sgMatch.winnerId,
    endReason: sgMatch.endReason,
    startedAt: sgMatch.startedAt,
  };
}

function serSgPlayers() {
  const out = [];
  for (const p of sgPlayers.values()) {
    out.push([
      p.id,
      p.name,
      p.color,
      Math.round(p.x),
      Math.round(p.y),
      Math.round(p.hp),
      p.alive ? 1 : 0,
      p.spectator ? 1 : 0,
      p.kills || 0,
      p.deaths || 0,
      p.weaponTier || 0,
      p.armorTier || 0,
      p.face || 0,
      p.soups || 0,
      p.compassCharges || 0,
      p.sneakyCharges || 0,
      p.weightlessCharges || 0,
      p.invisUntil || 0,
      p.speedUntil || 0,
      p.hitGlowUntil || 0,
      p.nextCompassAt || 0,
      p.nextSneakyAt || 0,
      p.nextWeightlessAt || 0,
    ]);
  }
  return out;
}

function serSgChests() {
  const now = Date.now();
  return sgChests.map(c => [
    c.id,
    Math.round(c.x),
    Math.round(c.y),
    c.openedAt && now < c.nextRefillAt ? 1 : 0,
  ]);
}

function mkSgLb() {
  const lb = [];
  for (const p of sgPlayers.values()) {
    lb.push({
      id: p.id,
      n: p.name,
      k: p.kills || 0,
      hp: Math.round(p.hp || 0),
      a: p.alive ? 1 : 0,
      s: p.spectator ? 1 : 0,
    });
  }
  lb.sort((a, b) => (b.k - a.k) || (b.hp - a.hp) || (a.s - b.s));
  return lb.slice(0, 12);
}

function broadcastSurvival(data) {
  for (const [cws, conn] of connections) {
    if (conn.sgPlayerId || (conn.isAdmin && conn.adminGame === 'survival-games')) safeSend(cws, data);
  }
}

function sendSurvivalAdminState(ws) {
  const players = [];
  for (const p of sgPlayers.values()) {
    players.push({
      id: p.id,
      name: p.name,
      alive: !!p.alive,
      spectator: !!p.spectator,
      hp: Math.round(p.hp || 0),
      kills: p.kills || 0,
      deaths: p.deaths || 0,
      weaponTier: p.weaponTier || 0,
      armorTier: p.armorTier || 0,
      soups: p.soups || 0,
      compassCharges: p.compassCharges || 0,
      sneakyCharges: p.sneakyCharges || 0,
      weightlessCharges: p.weightlessCharges || 0,
      invisUntil: p.invisUntil || 0,
      speedUntil: p.speedUntil || 0,
      hitGlowUntil: p.hitGlowUntil || 0,
      nextCompassAt: p.nextCompassAt || 0,
      nextSneakyAt: p.nextSneakyAt || 0,
      nextWeightlessAt: p.nextWeightlessAt || 0,
      device: p.device || 'Unknown',
    });
  }
  safeSend(ws, JSON.stringify({
    t: 'sgas',
    players,
    cfg: sgConfig,
    match: sgMatchPayload(),
    chestCount: sgChests.length,
    chestVer: sgChestVer,
    gen: sgGen,
    events: sgEvents.slice(-120),
  }));
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

  // ---- Food collisions — all players ----
  let foodEatenThisTick = 0;
  const regFoodCap = (gameConfig.gameMode === 'azoz') ? gameConfig.azozMaxFoodMass : MAX_MASS;
  for (const p of players.values()) {
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

  // ---- Red Mushroom collisions — all players ----
  const mushroomActive = gameConfig.gameMode === 'azoz' || gameConfig.redMushroom;
  if (mushroomActive && mushrooms.length > 0) {
    for (const p of players.values()) {
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
  for (const [cws, conn] of connections) {
    if (conn.playerId || (conn.isAdmin && conn.adminGame !== 'survival-games')) safeSend(cws, data);
  }
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
    const sgTotal = sgPlayers.size;
    const sgAlive = sgAlivePlayers().length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ s: 'ok', h, b, paused: serverPaused, sgTotal, sgAlive, sgPhase: sgMatch.phase }));
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
  const conn = { playerId: null, sgPlayerId: null, isAdmin: false, adminGame: 'agar', ip };
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
    if (conn.sgPlayerId) {
      const sp = sgPlayers.get(conn.sgPlayerId);
      if (sp) sgLog('leave', `${sp.name} left`);
      sgPlayers.delete(conn.sgPlayerId);
      conn.sgPlayerId = null;
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

function sgJoin(ws, conn, msg) {
  if (serverPaused) { safeSend(ws, JSON.stringify({ t: 'sgk', reason: 'Server is paused by admin.' })); return; }
  if (conn.playerId) {
    const old = players.get(conn.playerId);
    if (old) logActivity('leave', old.name, old.device || '', conn.ip);
    players.delete(conn.playerId);
    conn.playerId = null;
  }
  const name = String((msg.name || 'Survivor')).trim().slice(0, 20) || 'Survivor';
  for (const [id, p] of sgPlayers) {
    if (p.name.toLowerCase() !== name.toLowerCase()) continue;
    for (const [ows, oc] of connections) {
      if (oc.sgPlayerId === id && ows !== ws && ows.readyState === 1) {
        safeSend(ows, JSON.stringify({ t: 'sgk', reason: 'Another session joined with your name' }));
      }
    }
    sgPlayers.delete(id);
  }

  const id = `sg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const p = {
    id,
    name,
    color: pick(CLR),
    x: SG_CENTER.x,
    y: SG_CENTER.y,
    mx: 0,
    my: 0,
    face: 0,
    hp: SG_MAX_HP,
    alive: true,
    spectator: false,
    kills: 0,
    deaths: 0,
    weaponTier: 0,
    armorTier: 0,
    soups: 1,
    compassCharges: 1,
    sneakyCharges: 1,
    weightlessCharges: 1,
    invulnUntil: 0,
    invisUntil: 0,
    speedUntil: 0,
    hitGlowUntil: 0,
    nextCompassAt: 0,
    nextSneakyAt: 0,
    nextWeightlessAt: 0,
    lastAttack: 0,
    lastPing: Date.now(),
    joinTime: Date.now(),
    device: parseDevice(msg.ua || 'Unknown'),
  };

  if (sgMatch.phase === 'running' && sgConfig.lateJoinAsSpectator) sgSetSpectator(p);
  else sgResetPlayerForRound(p);

  sgPlayers.set(id, p);
  conn.sgPlayerId = id;
  conn.playerId = null;
  sgLog('join', `${name} joined Survival Games`);

  safeSend(ws, JSON.stringify({
    t: 'sgw',
    id,
    w: SG_W,
    h: SG_H,
    cfg: sgConfig,
    match: sgMatchPayload(),
    p: serSgPlayers(),
    c: serSgChests(),
    lb: mkSgLb(),
    gen: sgGen,
    ev: sgEvents.slice(-20),
  }));
}

function sgInput(conn, msg) {
  if (!conn.sgPlayerId) return;
  const p = sgPlayers.get(conn.sgPlayerId);
  if (!p) return;
  if (typeof msg.mx === 'number' && Number.isFinite(msg.mx)) p.mx = clp(msg.mx, -1, 1);
  if (typeof msg.my === 'number' && Number.isFinite(msg.my)) p.my = clp(msg.my, -1, 1);
  if (typeof msg.face === 'number' && Number.isFinite(msg.face)) p.face = msg.face;
  p.lastPing = Date.now();
}

function sgLeave(conn) {
  if (!conn.sgPlayerId) return;
  const p = sgPlayers.get(conn.sgPlayerId);
  if (p) sgLog('leave', `${p.name} left Survival Games`);
  sgPlayers.delete(conn.sgPlayerId);
  conn.sgPlayerId = null;
}

function sgUpdateConfig(msg) {
  const numeric = [
    'minPlayersToStart', 'countdownSec', 'graceSec', 'matchDurationSec',
    'moveSpeed', 'attackCooldownMs', 'attackRange', 'baseDamage',
    'soupHeal', 'compassCooldownSec', 'invisDurationSec', 'invisCooldownSec',
    'speedBoostMultiplier', 'speedBoostDurationSec', 'speedBoostCooldownSec',
    'chestTier2Chance', 'chestTier3Chance',
    'borderStartRadius', 'borderEndRadius', 'borderShrinkDelaySec', 'borderShrinkDurationSec',
    'borderDamagePerSec', 'chestOpenRange', 'chestRefillSec', 'weaponMaxTier', 'armorMaxTier', 'autoResetSec',
  ];
  for (const k of numeric) {
    if (msg[k] === undefined) continue;
    const v = Number(msg[k]);
    if (!Number.isFinite(v)) continue;
    sgConfig[k] = v;
  }
  if (msg.lateJoinAsSpectator !== undefined) sgConfig.lateJoinAsSpectator = !!msg.lateJoinAsSpectator;

  sgConfig.minPlayersToStart = clp(Math.round(sgConfig.minPlayersToStart), 1, 50);
  sgConfig.countdownSec = clp(Math.round(sgConfig.countdownSec), 3, 60);
  sgConfig.graceSec = clp(Math.round(sgConfig.graceSec), 0, 120);
  sgConfig.matchDurationSec = clp(Math.round(sgConfig.matchDurationSec), 30, 1800);
  sgConfig.moveSpeed = clp(sgConfig.moveSpeed, 80, 1200);
  sgConfig.attackCooldownMs = clp(Math.round(sgConfig.attackCooldownMs), 150, 5000);
  sgConfig.attackRange = clp(sgConfig.attackRange, 30, 400);
  sgConfig.baseDamage = clp(sgConfig.baseDamage, 1, 120);
  sgConfig.soupHeal = clp(sgConfig.soupHeal, 1, 100);
  sgConfig.compassCooldownSec = clp(Math.round(sgConfig.compassCooldownSec), 1, 120);
  sgConfig.invisDurationSec = clp(Math.round(sgConfig.invisDurationSec), 1, 60);
  sgConfig.invisCooldownSec = clp(Math.round(sgConfig.invisCooldownSec), 1, 240);
  sgConfig.speedBoostMultiplier = clp(sgConfig.speedBoostMultiplier, 1.01, 4);
  sgConfig.speedBoostDurationSec = clp(Math.round(sgConfig.speedBoostDurationSec), 1, 60);
  sgConfig.speedBoostCooldownSec = clp(Math.round(sgConfig.speedBoostCooldownSec), 1, 240);
  sgConfig.chestTier2Chance = clp(sgConfig.chestTier2Chance, 0, 0.95);
  sgConfig.chestTier3Chance = clp(sgConfig.chestTier3Chance, 0, 0.95);
  sgConfig.borderStartRadius = clp(sgConfig.borderStartRadius, 300, 3000);
  sgConfig.borderEndRadius = clp(sgConfig.borderEndRadius, 100, sgConfig.borderStartRadius);
  sgConfig.borderShrinkDelaySec = clp(Math.round(sgConfig.borderShrinkDelaySec), 0, 900);
  sgConfig.borderShrinkDurationSec = clp(Math.round(sgConfig.borderShrinkDurationSec), 1, 1800);
  sgConfig.borderDamagePerSec = clp(sgConfig.borderDamagePerSec, 1, 100);
  sgConfig.chestOpenRange = clp(sgConfig.chestOpenRange, 20, 300);
  sgConfig.chestRefillSec = clp(Math.round(sgConfig.chestRefillSec), 5, 600);
  sgConfig.weaponMaxTier = clp(Math.round(sgConfig.weaponMaxTier), 0, 10);
  sgConfig.armorMaxTier = clp(Math.round(sgConfig.armorMaxTier), 0, 10);
  sgConfig.autoResetSec = clp(Math.round(sgConfig.autoResetSec), 5, 180);

  if (sgMatch.phase === 'lobby' || sgMatch.phase === 'countdown') {
    sgMatch.borderRadius = sgConfig.borderStartRadius;
  }
}

function handleMessage(ws, conn, msg) {
  switch (msg.t) {
    // ---- Survival Games Join ----
    case 'sgj': {
      sgJoin(ws, conn, msg);
      break;
    }
    // ---- Survival Games Input ----
    case 'sgi': {
      sgInput(conn, msg);
      break;
    }
    // ---- Survival Games Attack ----
    case 'sgatk': {
      if (!conn.sgPlayerId) break;
      sgTryAttack(sgPlayers.get(conn.sgPlayerId));
      break;
    }
    // ---- Survival Games Compass ----
    case 'sgcompass': {
      if (!conn.sgPlayerId) break;
      sgTryCompass(sgPlayers.get(conn.sgPlayerId), ws);
      break;
    }
    // ---- Survival Games Soup ----
    case 'sgsoup': {
      if (!conn.sgPlayerId) break;
      sgTrySoup(sgPlayers.get(conn.sgPlayerId));
      break;
    }
    // ---- Survival Games Ability ----
    case 'sgability': {
      if (!conn.sgPlayerId) break;
      const ability = String(msg.a || '');
      if (ability === 'sneaky' || ability === 'weightless') {
        sgTryAbility(sgPlayers.get(conn.sgPlayerId), ability);
      }
      break;
    }
    // ---- Survival Games Open Chest ----
    case 'sgopen': {
      if (!conn.sgPlayerId) break;
      sgTryOpenChest(sgPlayers.get(conn.sgPlayerId));
      break;
    }
    // ---- Survival Games Leave ----
    case 'sgl': {
      sgLeave(conn);
      break;
    }
    // ---- Join ----
    case 'j': {
      if (serverPaused) { ws.send(JSON.stringify({ t: 'k', reason: 'Server is currently paused. Try again later.' })); return; }
      if (conn.sgPlayerId) sgLeave(conn);
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
    // ---- Voice Chat Chunk Relay ----
    case 'vc': {
      if (!gameConfig.voiceChatEnabled) return;
      const p = players.get(conn.playerId);
      if (!p || p.isBot || p.dead) return;
      const b64 = typeof msg.d === 'string' ? msg.d : '';
      if (!b64 || b64.length > 120000) return; // avoid oversized payloads
      const mime = (typeof msg.mime === 'string' ? msg.mime : 'audio/webm').slice(0, 80);
      const payload = JSON.stringify({ t: 'vc', pid: p.id, name: p.name, mime, d: b64 });
      for (const [ows, oc] of connections) {
        if (ows === ws) continue;
        if (!oc.playerId) continue;
        safeSend(ows, payload);
      }
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
      const lengthRaw = Number(gameConfig.laserLength ?? gameConfig.laserRange);
      const range = Number.isFinite(lengthRaw) ? clp(lengthRaw, 50, 5000) : 400;
      const widthRaw = Number(gameConfig.laserWidth);
      const beamWidth = Number.isFinite(widthRaw) ? clp(widthRaw, 1, 200) : 8;
      const killMode = !!gameConfig.laserCellKill;
      const ex = c.x + Math.cos(angle) * range;
      const ey = c.y + Math.sin(angle) * range;
      const dx = ex - c.x;
      const dy = ey - c.y;
      const a2 = dx * dx + dy * dy;
      if (a2 <= 1e-6) return;
      // Check hits against all other players
      const hits = [];
      for (const [vid, vp] of players) {
        if (vid === p.id) continue;
        if (vp.phaseOutUntil && now < vp.phaseOutUntil) continue;
        const touched = [];
        for (const cell of vp.cells) {
          // Point-to-segment distance check
          const cr = rad(cell.m) + beamWidth * 0.5;
          const fx = c.x - cell.x, fy = c.y - cell.y;
          const b2 = 2 * (fx * dx + fy * dy);
          const c2 = fx * fx + fy * fy - cr * cr;
          let disc = b2 * b2 - 4 * a2 * c2;
          if (disc >= 0) {
            disc = Math.sqrt(disc);
            const t1 = (-b2 - disc) / (2 * a2);
            const t2 = (-b2 + disc) / (2 * a2);
            if ((t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1) || (t1 < 0 && t2 > 1)) touched.push(cell);
          }
        }
        if (touched.length === 0) continue;

        if (killMode) {
          // Main cell is the largest current cell. Hitting it wipes the whole player.
          let main = vp.cells[0] || null;
          for (const cell of vp.cells) {
            if (!main || cell.m > main.m) main = cell;
          }
          const hitMain = !!main && touched.some(cell => cell.id === main.id);
          if (hitMain) {
            const removed = vp.cells.length;
            vp.cells = [];
            for (let i = 0; i < Math.max(1, removed); i++) hits.push({ pid: vid, cid: main ? main.id : 'main', k: 'main' });
            continue;
          }
          const touchedIds = new Set(touched.map(cell => cell.id));
          vp.cells = vp.cells.filter(cell => !touchedIds.has(cell.id));
          for (const cell of touched) hits.push({ pid: vid, cid: cell.id, k: 'cell' });
        } else {
          for (const cell of touched) {
            const dmg = Math.min(cell.m - 1, gameConfig.laserDamage);
            if (dmg <= 0) continue;
            cell.m -= dmg;
            hits.push({ pid: vid, cid: cell.id, dmg });
          }
        }
      }
      // Broadcast laser visual to all players
      broadcast(JSON.stringify({
        t: 'laser',
        from: { x: Math.round(c.x), y: Math.round(c.y) },
        to: { x: Math.round(ex), y: Math.round(ey) },
        color: p.color,
        width: beamWidth,
        pid: p.id,
        hits: hits.length,
      }));
      break;
    }
    // ---- Admin Auth ----
    case 'aa': {
      if (msg.pw === ADMIN_PW) {
        conn.isAdmin = true;
        const requestedGame = String(msg.game || 'agar');
        conn.adminGame = (requestedGame === 'survival-games' || requestedGame === 'sg') ? 'survival-games' : 'agar';
        ws.send(JSON.stringify({ t: 'aa', ok: 1, game: conn.adminGame }));
        if (conn.adminGame === 'survival-games') sendSurvivalAdminState(ws);
        else sendAdminState(ws);
      } else {
        ws.send(JSON.stringify({ t: 'aa', ok: 0 }));
      }
      break;
    }
    // ---- Survival Games Admin Config ----
    case 'sgcfg': {
      if (!conn.isAdmin || conn.adminGame !== 'survival-games') return;
      sgUpdateConfig(msg);
      broadcastSurvival(JSON.stringify({ t: 'sgcfg', cfg: sgConfig }));
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'survival_admin_config' }));
      break;
    }
    // ---- Survival Games Admin Start ----
    case 'sgstart': {
      if (!conn.isAdmin || conn.adminGame !== 'survival-games') return;
      if (sgMatch.phase === 'running') {
        safeSend(ws, JSON.stringify({ t: 'am', ok: 0, action: 'survival_admin_start' }));
        break;
      }
      sgStartMatch();
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'survival_admin_start' }));
      break;
    }
    // ---- Survival Games Admin Stop ----
    case 'sgstop': {
      if (!conn.isAdmin || conn.adminGame !== 'survival-games') return;
      sgEndMatch(null, 'stopped-by-admin');
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'survival_admin_stop' }));
      break;
    }
    // ---- Survival Games Admin Reset ----
    case 'sgreset': {
      if (!conn.isAdmin || conn.adminGame !== 'survival-games') return;
      const hard = !!msg.hard;
      sgResetRound(!hard);
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'survival_admin_reset' }));
      break;
    }
    // ---- Admin Pause / Resume ----
    case 'apause': {
      if (!conn.isAdmin) return;
      serverPaused = !!msg.paused;
      if (serverPaused) {
        // Kick all non-admin players and bots in all game modes.
        for (const [ows, oc] of connections) {
          if (!oc.isAdmin && ows.readyState === 1) {
            if (oc.playerId) ows.send(JSON.stringify({ t: 'k', reason: 'Server has been paused by admin.' }));
            if (oc.sgPlayerId) ows.send(JSON.stringify({ t: 'sgk', reason: 'Server has been paused by admin.' }));
          }
        }
        // Remove all players (bots + humans) in both modes.
        players.clear();
        sgPlayers.clear();
        sgResetRound(false);
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
      const playerType = String(msg.playerType || 'bot') === 'human' ? 'human' : 'bot';
      const isBot = playerType === 'bot';
      const defaultName = isBot ? '🤖 Bot' : '👤 Guest';
      const spawnName = ((msg.name || '').trim() || defaultName).slice(0, 20);
      const spawnMass = Math.max(SM, Math.min(msg.mass || 50, 10000));
      const spawnId = `${isBot ? 'bot' : 'npc'}-${uid()}`;
      const color = pick(CLR), pos = rp();
      const spawned = {
        id: spawnId, name: spawnName, color, isBot, feedBonus: 0,
        cells: [{ id: uid(), x: pos.x, y: pos.y, m: spawnMass, c: color }],
        mx: pos.x, my: pos.y, lastPing: Date.now(), device: isBot ? 'Bot' : 'Admin Spawn',
        dead: false, deathTime: 0, joinTime: Date.now(), peakMass: spawnMass, lastLaser: 0, lastSplitAt: 0, phaseOutUntil: 0,
      };
      if (isBot) {
        spawned.bot = { tx: pos.x, ty: pos.y, rt: Date.now() + 1000, scd: Date.now() + 5000 };
      }
      players.set(spawnId, spawned);
      ws.send(JSON.stringify({ t: 'am', ok: 1, action: 'admin_add_bot', botId: spawnId, playerId: spawnId, playerType }));
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
        'gameMode','laserCooldown','laserDamage','laserRange','laserLength','laserWidth','laserCellKill','bgMusic',
        'movementStyle','mobileControlMode','voiceChatEnabled',
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
        if (k === 'laserRange' || k === 'laserLength') {
          const v = Number(msg[k]);
          if (Number.isFinite(v)) {
            const len = clp(v, 50, 5000);
            gameConfig.laserRange = len;
            gameConfig.laserLength = len;
          }
          continue;
        }
        if (k === 'laserWidth') {
          const v = Number(msg[k]);
          if (Number.isFinite(v)) gameConfig.laserWidth = clp(v, 1, 200);
          continue;
        }
        if (k === 'laserCellKill') {
          gameConfig.laserCellKill = !!msg[k];
          continue;
        }
        if (k === 'movementStyle') {
          const v = String(msg[k]);
          gameConfig.movementStyle = (v === 'lastDirection' || v === 'screenOffset') ? v : 'pointer';
          continue;
        }
        if (k === 'mobileControlMode') {
          const v = String(msg[k]);
          gameConfig.mobileControlMode = (v === 'landscape') ? 'landscape' : 'classic';
          continue;
        }
        if (k === 'voiceChatEnabled') {
          gameConfig.voiceChatEnabled = !!msg[k];
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
        const next = [];
        for (const shape of msg.shapes) {
          const clean = sanitizeGridShape(shape);
          if (clean) next.push(clean);
          if (next.length >= 100) break;
        }
        gridShapes = next;
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
  sgTick();
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
    broadcastSurvivalState();
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

function broadcastSurvivalState() {
  const state = {
    t: 'sgu',
    p: serSgPlayers(),
    lb: mkSgLb(),
    m: sgMatchPayload(),
    cv: sgChestVer,
    c: serSgChests(),
    cfg: sgConfig,
    gen: sgGen,
  };
  if (sgEvents.length > sgLastEventBroadcastLen) {
    state.ev = sgEvents.slice(sgLastEventBroadcastLen).map(e => ({ ts: e.ts, type: e.type, msg: e.msg }));
    sgLastEventBroadcastLen = sgEvents.length;
  }
  broadcastSurvival(JSON.stringify(state));
}

function broadcastAdminState() {
  for (const [ws, conn] of connections) {
    if (conn.isAdmin && ws.readyState === 1) {
      try {
        if (conn.adminGame === 'survival-games') sendSurvivalAdminState(ws);
        else sendAdminState(ws);
      } catch (_) { /* ignore */ }
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
