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
  moveSpeed: 395, // units per second
  jumpCooldownSec: 0.82,
  jumpDurationMs: 560,
  jumpImpulseSpeed: 720,
  attackCooldownMs: 560,
  attackRange: 145,
  attackFovDeg: 155,
  baseDamage: 24,
  knockback: 100,
  attackLunge: 34,
  spawnInvulnSec: 2.5,
  soupHeal: 32,
  compassCooldownSec: 10,
  invisDurationSec: 6,
  invisCooldownSec: 35,
  speedBoostMultiplier: 1.55,
  speedBoostDurationSec: 6,
  speedBoostCooldownSec: 30,
  feastEnabled: true,
  feastTimeSec: 150,
  feastAnnounceLeadSec: 25,
  feastChestCount: 7,
  chestTier2Chance: 0.32,
  chestTier3Chance: 0.12,
  borderStartRadius: 2300,
  borderEndRadius: 500,
  borderShrinkDelaySec: 72,
  borderShrinkDurationSec: 210,
  borderDamagePerSec: 16,
  chestOpenRange: 110,
  chestRefillSec: 75,
  weaponMaxTier: 4,
  armorMaxTier: 3,
  lateJoinAsSpectator: false,
  autoResetSec: 12,
  mapSeed: 1337,
  mapPropDensity: 0.84,
  mapObstacleCount: 136,
  mapLaneWidth: 138,
  mapSizeVariance: 0.9,
  botFillEnabled: true,
  botFillTargetPlayers: 6,
  botFillMaxBots: 8,
  botDifficulty: 1.28,
  relicsEnabled: true,
  relicSpawnIntervalSec: 12,
  relicLifetimeSec: 75,
  relicMaxActive: 9,
  relicPickupRange: 78,
  shrineEnabled: true,
  shrineCount: 6,
  shrineRadius: 92,
  shrineBuffSec: 18,
  shrineCooldownSec: 55,
  passiveRegenPerSec: 2.8,
  combatRegenDelaySec: 5.5,
  stormEnabled: true,
  stormEverySec: 78,
  stormDurationSec: 16,
  stormRadius: 520,
  stormDamagePerSec: 14,
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
  feastAt: 0,
  feastTriggered: false,
  feastAnnounced: false,
  borderRadius: 2300,
};

const SG_CHEST_POINTS = [
  { x: 2600, y: 2600 }, { x: 2600, y: 900 }, { x: 2600, y: 4300 }, { x: 900, y: 2600 }, { x: 4300, y: 2600 },
  { x: 1350, y: 1350 }, { x: 3850, y: 1350 }, { x: 1350, y: 3850 }, { x: 3850, y: 3850 },
  { x: 2600, y: 1400 }, { x: 2600, y: 3800 }, { x: 1400, y: 2600 }, { x: 3800, y: 2600 },
  { x: 1000, y: 1700 }, { x: 1700, y: 1000 }, { x: 4200, y: 1700 }, { x: 3500, y: 1000 },
  { x: 1000, y: 3500 }, { x: 1700, y: 4200 }, { x: 4200, y: 3500 }, { x: 3500, y: 4200 },
];
const SG_POI_BLUEPRINTS = [
  { name: 'Temple Ruins', x: 2600, y: 2600, tier: 3 },
  { name: 'North Keep', x: 2600, y: 820, tier: 2 },
  { name: 'South Keep', x: 2600, y: 4380, tier: 2 },
  { name: 'West Watch', x: 820, y: 2600, tier: 2 },
  { name: 'East Watch', x: 4380, y: 2600, tier: 2 },
  { name: 'Sandy Hamlet', x: 1280, y: 1180, tier: 1 },
  { name: 'Pine Hamlet', x: 3920, y: 1180, tier: 1 },
  { name: 'Marsh Hamlet', x: 1280, y: 4020, tier: 1 },
  { name: 'Forge Hamlet', x: 3920, y: 4020, tier: 1 },
  { name: 'Broken Bridge', x: 1730, y: 970, tier: 1 },
  { name: 'Bone Camp', x: 3520, y: 970, tier: 1 },
  { name: 'Moss Camp', x: 1730, y: 4230, tier: 1 },
  { name: 'Bluff Camp', x: 3520, y: 4230, tier: 1 },
  { name: 'Sunken Well', x: 930, y: 3480, tier: 1 },
  { name: 'Windmill Field', x: 4300, y: 1710, tier: 1 },
];

let sgChests = [];
let sgMapVer = 0;
let sgLastBroadcastMapVer = -1;
let sgMap = { seed: 1337, props: [], pois: [] };
const SG_MAP_GRID_CELL = 220;
const sgMapGrid = new Map();
const SG_MAP_MIN_EDGE = 120;
const SG_RELIC_TYPES = [
  {
    id: 'fury',
    name: 'Fury Idol',
    buffSec: 16,
    hp: 6,
    weapon: 1,
  },
  {
    id: 'fortify',
    name: 'Fortify Core',
    buffSec: 20,
    hp: 10,
    armor: 1,
  },
  {
    id: 'swift',
    name: 'Swift Rune',
    buffSec: 15,
    hp: 0,
    speed: 1,
  },
  {
    id: 'tracker',
    name: 'Tracker Lens',
    buffSec: 22,
    hp: 0,
    compass: 2,
  },
  {
    id: 'renew',
    name: 'Renew Ember',
    buffSec: 18,
    hp: 14,
    regen: 1,
  },
];
const SG_SHRINE_TYPES = [
  { id: 'fury', name: 'Shrine Of Fury', kind: 0, color: '#f87171' },
  { id: 'fortify', name: 'Shrine Of Fortify', kind: 1, color: '#60a5fa' },
  { id: 'swift', name: 'Shrine Of Swift', kind: 2, color: '#34d399' },
  { id: 'tracker', name: 'Shrine Of Tracker', kind: 3, color: '#fde047' },
];
let sgRelics = [];
let sgRelicVer = 0;
let sgLastBroadcastRelicVer = -1;
let sgLastRelicSpawnAt = 0;
let sgShrines = [];
let sgShrineVer = 0;
let sgLastBroadcastShrineVer = -1;
let sgStorm = {
  active: false,
  x: SG_CENTER.x,
  y: SG_CENTER.y,
  r: 500,
  startedAt: 0,
  endsAt: 0,
  nextAt: 0,
};
let sgStormVer = 0;
let sgLastBroadcastStormVer = -1;

function sgFlagVerRelics() {
  sgRelicVer++;
}

function sgFlagVerShrines() {
  sgShrineVer++;
}

function sgFlagVerStorm() {
  sgStormVer++;
}

function sgPlayerHasBuff(p, buff, now = Date.now()) {
  if (!p) return false;
  if (buff === 'fury') return now < (p.furyUntil || 0);
  if (buff === 'fortify') return now < (p.fortifyUntil || 0);
  if (buff === 'swift') return now < (p.swiftUntil || 0);
  if (buff === 'tracker') return now < (p.trackerUntil || 0);
  if (buff === 'renew') return now < (p.regenBoostUntil || 0);
  return false;
}

function sgMkRng(seed) {
  let s = (Math.abs(Math.floor(seed || 1)) >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sgGridKey(cx, cy) {
  return `${cx}|${cy}`;
}

function sgMapBounds(prop) {
  if (!prop) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  if (prop.shape === 'circle') {
    return {
      minX: prop.x - prop.r,
      maxX: prop.x + prop.r,
      minY: prop.y - prop.r,
      maxY: prop.y + prop.r,
    };
  }
  return {
    minX: prop.x - prop.w * 0.5,
    maxX: prop.x + prop.w * 0.5,
    minY: prop.y - prop.d * 0.5,
    maxY: prop.y + prop.d * 0.5,
  };
}

function sgRebuildMapGrid() {
  sgMapGrid.clear();
  for (let i = 0; i < sgMap.props.length; i++) {
    const b = sgMapBounds(sgMap.props[i]);
    const minCX = Math.floor(b.minX / SG_MAP_GRID_CELL);
    const maxCX = Math.floor(b.maxX / SG_MAP_GRID_CELL);
    const minCY = Math.floor(b.minY / SG_MAP_GRID_CELL);
    const maxCY = Math.floor(b.maxY / SG_MAP_GRID_CELL);
    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cy = minCY; cy <= maxCY; cy++) {
        const k = sgGridKey(cx, cy);
        let arr = sgMapGrid.get(k);
        if (!arr) {
          arr = [];
          sgMapGrid.set(k, arr);
        }
        arr.push(i);
      }
    }
  }
}

function sgNearbyMapProps(x, y, radius = 140) {
  const minCX = Math.floor((x - radius) / SG_MAP_GRID_CELL);
  const maxCX = Math.floor((x + radius) / SG_MAP_GRID_CELL);
  const minCY = Math.floor((y - radius) / SG_MAP_GRID_CELL);
  const maxCY = Math.floor((y + radius) / SG_MAP_GRID_CELL);
  const idxs = new Set();
  for (let cx = minCX; cx <= maxCX; cx++) {
    for (let cy = minCY; cy <= maxCY; cy++) {
      const arr = sgMapGrid.get(sgGridKey(cx, cy));
      if (!arr) continue;
      for (const i of arr) idxs.add(i);
    }
  }
  const out = [];
  for (const i of idxs) out.push(sgMap.props[i]);
  return out;
}

function sgPointInProp(x, y, prop, pad = 0) {
  if (!prop) return false;
  if (prop.shape === 'circle') {
    const d2 = (x - prop.x) * (x - prop.x) + (y - prop.y) * (y - prop.y);
    const r = Math.max(0, prop.r + pad);
    return d2 <= r * r;
  }
  const minX = prop.x - prop.w * 0.5 - pad;
  const maxX = prop.x + prop.w * 0.5 + pad;
  const minY = prop.y - prop.d * 0.5 - pad;
  const maxY = prop.y + prop.d * 0.5 + pad;
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

function sgPointBlocked(x, y, pad = 0) {
  const nearby = sgNearbyMapProps(x, y, 120 + pad);
  for (const p of nearby) {
    if (sgPointInProp(x, y, p, pad)) return true;
  }
  return false;
}

function sgSegmentBlocked(ax, ay, bx, by, pad = 0) {
  const d = dst(ax, ay, bx, by);
  const steps = Math.max(6, Math.ceil(d / 45));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    if (sgPointBlocked(x, y, pad)) return true;
  }
  return false;
}

function sgResolveMapCollision(p, pad = 18) {
  if (!p) return;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    const nearby = sgNearbyMapProps(p.x, p.y, 180 + pad);
    for (const o of nearby) {
      if (o.shape === 'circle') {
        const dx = p.x - o.x;
        const dy = p.y - o.y;
        const rr = o.r + pad;
        const d = Math.hypot(dx, dy);
        if (d < rr) {
          if (d < 1e-4) {
            const a = ((p.id || '').charCodeAt(0) + pass * 1.73) % (Math.PI * 2);
            p.x = o.x + Math.cos(a) * rr;
            p.y = o.y + Math.sin(a) * rr;
          } else {
            p.x = o.x + (dx / d) * rr;
            p.y = o.y + (dy / d) * rr;
          }
          moved = true;
        }
      } else {
        const minX = o.x - o.w * 0.5 - pad;
        const maxX = o.x + o.w * 0.5 + pad;
        const minY = o.y - o.d * 0.5 - pad;
        const maxY = o.y + o.d * 0.5 + pad;
        if (p.x > minX && p.x < maxX && p.y > minY && p.y < maxY) {
          const dl = Math.abs(p.x - minX);
          const dr = Math.abs(maxX - p.x);
          const dt = Math.abs(p.y - minY);
          const db = Math.abs(maxY - p.y);
          const m = Math.min(dl, dr, dt, db);
          if (m === dl) p.x = minX;
          else if (m === dr) p.x = maxX;
          else if (m === dt) p.y = minY;
          else p.y = maxY;
          moved = true;
        }
      }
      sgClampPos(p);
    }
    if (!moved) break;
  }
}

function sgFindFreeSpot(x, y, pad = 18) {
  const out = { x: clp(x, SG_MAP_MIN_EDGE, SG_W - SG_MAP_MIN_EDGE), y: clp(y, SG_MAP_MIN_EDGE, SG_H - SG_MAP_MIN_EDGE) };
  if (!sgPointBlocked(out.x, out.y, pad)) return out;
  for (let radius = 26; radius <= 360; radius += 22) {
    const n = 14 + Math.floor(radius / 22);
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n;
      const tx = clp(out.x + Math.cos(a) * radius, SG_MAP_MIN_EDGE, SG_W - SG_MAP_MIN_EDGE);
      const ty = clp(out.y + Math.sin(a) * radius, SG_MAP_MIN_EDGE, SG_H - SG_MAP_MIN_EDGE);
      if (!sgPointBlocked(tx, ty, pad)) return { x: tx, y: ty };
    }
  }
  return out;
}

function serSgMapProps() {
  const out = [];
  for (const p of sgMap.props) {
    if (p.shape === 'circle') out.push([p.id, 0, Math.round(p.x), Math.round(p.y), Math.round(p.r), Math.round(p.h), p.kind | 0]);
    else out.push([p.id, 1, Math.round(p.x), Math.round(p.y), Math.round(p.w), Math.round(p.d), Math.round(p.h), p.kind | 0]);
  }
  return out;
}

function serSgPois() {
  return sgMap.pois.map(p => [p.id, p.name, Math.round(p.x), Math.round(p.y), p.tier | 0]);
}

function sgDistancePointToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 <= 1e-6) return Math.hypot(apx, apy);
  let t = (apx * abx + apy * aby) / ab2;
  t = clp(t, 0, 1);
  const qx = ax + abx * t;
  const qy = ay + aby * t;
  return Math.hypot(px - qx, py - qy);
}

function sgCarveMapLanes(props) {
  if (!Array.isArray(props) || props.length === 0) return props;
  const laneWidth = clp(Number(sgConfig.mapLaneWidth) || 118, 50, 280);
  const kept = [];
  for (const o of props) {
    const proxy = o.shape === 'circle' ? o.r : Math.max(o.w, o.d) * 0.55;
    let blocked = false;

    // Ring path near the starting border to keep macro rotation fun.
    const centerDist = dst(o.x, o.y, SG_CENTER.x, SG_CENTER.y);
    const ringRadius = clp(Number(sgConfig.borderStartRadius) || 2300, 600, 2800);
    if (Math.abs(centerDist - ringRadius * 0.74) < laneWidth * 0.64 + proxy * 0.42) {
      blocked = true;
    }

    // Primary lanes from center toward each POI.
    if (!blocked) {
      for (const p of SG_POI_BLUEPRINTS) {
        const d = sgDistancePointToSegment(o.x, o.y, SG_CENTER.x, SG_CENTER.y, p.x, p.y);
        if (d < laneWidth + proxy * 0.52) {
          blocked = true;
          break;
        }
      }
    }

    // Cardinal crossing lanes for reliable fallback pathing.
    if (!blocked) {
      const inX = Math.abs(o.x - SG_CENTER.x) < laneWidth * 0.7 + proxy * 0.42;
      const inY = Math.abs(o.y - SG_CENTER.y) < laneWidth * 0.7 + proxy * 0.42;
      if (inX || inY) blocked = true;
    }

    if (!blocked) kept.push(o);
  }
  return kept;
}

function sgGenerateMap(seedInput) {
  const seed = (Math.abs(Math.floor(seedInput ?? sgConfig.mapSeed ?? 1337)) >>> 0) || 1;
  const rnd = sgMkRng(seed);
  const pois = SG_POI_BLUEPRINTS.map((p, i) => ({
    id: `poi-${i}`,
    name: p.name,
    x: p.x,
    y: p.y,
    tier: p.tier,
  }));
  const avoid = [{ x: SG_CENTER.x, y: SG_CENTER.y, r: 340 }];
  for (const c of SG_CHEST_POINTS) avoid.push({ x: c.x, y: c.y, r: 150 });
  for (const p of pois) avoid.push({ x: p.x, y: p.y, r: 110 });

  const targetCountBase = Number(sgConfig.mapObstacleCount) || 160;
  const density = Number(sgConfig.mapPropDensity) || 1;
  const targetCount = clp(Math.round(targetCountBase * density), 40, 500);
  const sizeVariance = clp(Number(sgConfig.mapSizeVariance) || 1, 0.5, 1.8);
  const densityScale = clp(1 + (density - 1) * 0.22, 0.74, 1.4);
  const props = [];
  let attempts = 0;
  while (props.length < targetCount && attempts < targetCount * 32) {
    attempts++;
    const circle = rnd() < 0.52;
    const x = SG_MAP_MIN_EDGE + rnd() * (SG_W - SG_MAP_MIN_EDGE * 2);
    const y = SG_MAP_MIN_EDGE + rnd() * (SG_H - SG_MAP_MIN_EDGE * 2);
    const h = circle ? 14 + rnd() * 24 : 18 + rnd() * 34;
    const kind = Math.floor(rnd() * 6);
    let rawR = circle ? (24 + rnd() * 54) * sizeVariance * densityScale : 0;
    let rawW = circle ? 0 : (38 + rnd() * 108) * sizeVariance * densityScale;
    let rawD = circle ? 0 : (38 + rnd() * 108) * sizeVariance * densityScale;
    const proxyR = circle ? rawR : Math.max(rawW, rawD) * 0.58;

    let blocked = false;
    for (const a of avoid) {
      if (dst(x, y, a.x, a.y) < a.r + proxyR + 10) { blocked = true; break; }
    }
    if (blocked) continue;

    // Prevent dense obstacle clumps to preserve pathing.
    const recent = props.slice(-50);
    for (const o of recent) {
      const oProxy = o.shape === 'circle' ? o.r : Math.max(o.w, o.d) * 0.58;
      if (dst(x, y, o.x, o.y) < (proxyR + oProxy) * 0.74) { blocked = true; break; }
    }
    if (blocked) continue;

    if (circle) {
      props.push({ id: `m-${props.length}`, shape: 'circle', x, y, r: rawR, h, kind });
    } else {
      props.push({ id: `m-${props.length}`, shape: 'rect', x, y, w: rawW, d: rawD, h, kind });
    }
  }
  let carved = sgCarveMapLanes(props);
  // Backfill if carving became too aggressive, while keeping lanes mostly clear.
  const minKept = Math.max(30, Math.floor(targetCount * 0.72));
  let refillAttempts = 0;
  while (carved.length < minKept && refillAttempts < targetCount * 24) {
    refillAttempts++;
    const circle = rnd() < 0.6;
    const x = SG_MAP_MIN_EDGE + rnd() * (SG_W - SG_MAP_MIN_EDGE * 2);
    const y = SG_MAP_MIN_EDGE + rnd() * (SG_H - SG_MAP_MIN_EDGE * 2);
    const r = (18 + rnd() * 30) * sizeVariance * 0.78;
    const w = (30 + rnd() * 70) * sizeVariance * 0.72;
    const d = (30 + rnd() * 70) * sizeVariance * 0.72;
    const h = 10 + rnd() * 20;
    const kind = Math.floor(rnd() * 6);
    const o = circle
      ? { id: `m-b-${carved.length}-${refillAttempts}`, shape: 'circle', x, y, r, h, kind }
      : { id: `m-b-${carved.length}-${refillAttempts}`, shape: 'rect', x, y, w, d, h, kind };
    const laneCheck = sgCarveMapLanes([o]);
    if (laneCheck.length === 0) continue;
    let collide = false;
    const proxy = circle ? r : Math.max(w, d) * 0.58;
    for (const prev of carved.slice(-120)) {
      const pProxy = prev.shape === 'circle' ? prev.r : Math.max(prev.w, prev.d) * 0.58;
      if (dst(o.x, o.y, prev.x, prev.y) < (proxy + pProxy) * 0.74) {
        collide = true;
        break;
      }
    }
    if (collide) continue;
    carved.push(o);
  }

  // Normalize IDs after lane carving/backfill.
  for (let i = 0; i < carved.length; i++) {
    carved[i].id = `m-${i}`;
  }

  sgMap = { seed, props: carved, pois };
  sgMapVer++;
  sgRebuildMapGrid();
}

function sgRelicTemplate(typeId) {
  for (const t of SG_RELIC_TYPES) {
    if (t.id === typeId) return t;
  }
  return SG_RELIC_TYPES[0];
}

function sgShrineTemplate(typeId) {
  for (const t of SG_SHRINE_TYPES) {
    if (t.id === typeId) return t;
  }
  return SG_SHRINE_TYPES[0];
}

function sgClearRelics(reason = 'reset') {
  if (sgRelics.length === 0) return;
  sgRelics = [];
  sgFlagVerRelics();
  if (reason) sgLog('system', `Relics cleared (${reason})`);
}

function sgBuildShrines() {
  const count = clp(Math.round(Number(sgConfig.shrineCount) || 6), 0, 16);
  const out = [];
  if (!sgConfig.shrineEnabled || count <= 0) {
    sgShrines = out;
    sgFlagVerShrines();
    return;
  }
  const ringR = Math.max(420, Math.min(1900, Math.round(sgConfig.borderStartRadius * 0.72)));
  for (let i = 0; i < count; i++) {
    const a = (Math.PI * 2 * i) / count;
    const rawX = SG_CENTER.x + Math.cos(a) * ringR;
    const rawY = SG_CENTER.y + Math.sin(a) * ringR;
    const pos = sgFindFreeSpot(rawX, rawY, 38);
    const tpl = SG_SHRINE_TYPES[i % SG_SHRINE_TYPES.length];
    out.push({
      id: `shr-${i}`,
      type: tpl.id,
      x: pos.x,
      y: pos.y,
      r: clp(Number(sgConfig.shrineRadius) || 92, 45, 220),
      nextReadyAt: 0,
      activations: 0,
    });
  }
  sgShrines = out;
  sgFlagVerShrines();
}

function sgSpawnRelic(now = Date.now(), forcedType = '') {
  if (!sgConfig.relicsEnabled) return null;
  const maxActive = clp(Math.round(Number(sgConfig.relicMaxActive) || 9), 1, 30);
  if (sgRelics.length >= maxActive) return null;

  let spot = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    let baseX = SG_CENTER.x;
    let baseY = SG_CENTER.y;
    if (sgMap.pois.length > 0 && Math.random() < 0.7) {
      const poi = pick(sgMap.pois);
      baseX = poi.x + (Math.random() * 240 - 120);
      baseY = poi.y + (Math.random() * 240 - 120);
    } else {
      baseX = SG_MAP_MIN_EDGE + Math.random() * (SG_W - SG_MAP_MIN_EDGE * 2);
      baseY = SG_MAP_MIN_EDGE + Math.random() * (SG_H - SG_MAP_MIN_EDGE * 2);
    }
    const trySpot = sgFindFreeSpot(baseX, baseY, 30);
    if (dst(trySpot.x, trySpot.y, SG_CENTER.x, SG_CENTER.y) < 150) continue;
    let tooClose = false;
    for (const r of sgRelics) {
      if (dst(trySpot.x, trySpot.y, r.x, r.y) < 140) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) {
      spot = trySpot;
      break;
    }
  }
  if (!spot) return null;

  const ttlSec = clp(Math.round(Number(sgConfig.relicLifetimeSec) || 75), 10, 500);
  const type =
    forcedType && SG_RELIC_TYPES.some(t => t.id === forcedType)
      ? forcedType
      : pick(SG_RELIC_TYPES).id;
  const tier = Math.random() < 0.1 ? 3 : Math.random() < 0.4 ? 2 : 1;
  const relic = {
    id: `rel-${now}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    x: spot.x,
    y: spot.y,
    tier,
    spawnAt: now,
    expiresAt: now + ttlSec * 1000,
  };
  sgRelics.push(relic);
  sgLastRelicSpawnAt = now;
  sgFlagVerRelics();
  const tpl = sgRelicTemplate(type);
  sgLog('system', `${tpl.name} appeared`);
  return relic;
}

function sgSpawnRelicWave(count = 3) {
  let spawned = 0;
  for (let i = 0; i < count; i++) {
    if (sgSpawnRelic(Date.now())) spawned++;
  }
  if (spawned > 0) sgLog('system', `Relic wave spawned (${spawned})`);
}

function sgApplyRelicBuff(player, typeId, tier = 1, source = 'relic') {
  const now = Date.now();
  if (!player || !player.alive || player.spectator) return false;
  const tpl = sgRelicTemplate(typeId);
  const tierMul = clp(tier, 1, 3);
  const baseSec = clp(Number(sgConfig.shrineBuffSec) || 18, 6, 90);
  const buffSec = clp((tpl.buffSec || baseSec) + (tierMul - 1) * 4, 6, 120);
  const until = now + buffSec * 1000;

  if (typeId === 'fury') {
    player.furyUntil = Math.max(player.furyUntil || 0, until);
    if ((tpl.weapon || 0) > 0) {
      player.weaponTier = clp((player.weaponTier || 0) + Math.max(1, Math.floor((tpl.weapon || 1) * tierMul * 0.6)), 0, sgConfig.weaponMaxTier);
    }
  } else if (typeId === 'fortify') {
    player.fortifyUntil = Math.max(player.fortifyUntil || 0, until);
    if ((tpl.armor || 0) > 0) {
      player.armorTier = clp((player.armorTier || 0) + Math.max(1, Math.floor((tpl.armor || 1) * tierMul * 0.6)), 0, sgConfig.armorMaxTier);
    }
  } else if (typeId === 'swift') {
    player.swiftUntil = Math.max(player.swiftUntil || 0, until);
  } else if (typeId === 'tracker') {
    player.trackerUntil = Math.max(player.trackerUntil || 0, until);
    player.compassCharges = clp((player.compassCharges || 0) + (tpl.compass || 1) + tierMul - 1, 0, 10);
  } else if (typeId === 'renew') {
    player.regenBoostUntil = Math.max(player.regenBoostUntil || 0, until);
  }

  const heal = Math.round((tpl.hp || 0) + tierMul * 2);
  if (heal > 0) player.hp = clp(player.hp + heal, 1, SG_MAX_HP);
  player.lastRelicAt = now;
  sgLog('ability', `${player.name} empowered by ${tpl.name} (${source})`);
  return true;
}

function sgTickRelics(now) {
  if (!sgConfig.relicsEnabled || sgMatch.phase !== 'running') {
    if (sgRelics.length > 0) {
      sgRelics = [];
      sgFlagVerRelics();
    }
    return;
  }

  const before = sgRelics.length;
  sgRelics = sgRelics.filter(r => now < r.expiresAt);
  if (sgRelics.length !== before) sgFlagVerRelics();

  const spawnEveryMs = clp(Math.round(Number(sgConfig.relicSpawnIntervalSec) || 18), 4, 240) * 1000;
  if (!sgLastRelicSpawnAt) sgLastRelicSpawnAt = now;
  if (now - sgLastRelicSpawnAt >= spawnEveryMs) {
    sgSpawnRelic(now);
  }

  if (sgRelics.length === 0) return;
  const range = clp(Number(sgConfig.relicPickupRange) || 78, 24, 200);
  const pickedIds = new Set();
  for (const p of sgPlayers.values()) {
    if (!p.alive || p.spectator) continue;
    let nearest = null;
    let best = Infinity;
    for (const r of sgRelics) {
      if (pickedIds.has(r.id)) continue;
      const d = dst(p.x, p.y, r.x, r.y);
      if (d < range && d < best) {
        best = d;
        nearest = r;
      }
    }
    if (!nearest) continue;
    pickedIds.add(nearest.id);
    sgApplyRelicBuff(p, nearest.type, nearest.tier, 'pickup');
    sgLog('loot', `${p.name} collected ${sgRelicTemplate(nearest.type).name}`);
  }
  if (pickedIds.size > 0) {
    sgRelics = sgRelics.filter(r => !pickedIds.has(r.id));
    sgFlagVerRelics();
  }
}

function sgTickShrines(now) {
  if (!sgConfig.shrineEnabled || sgMatch.phase !== 'running') return;
  if (sgShrines.length === 0) return;
  for (const s of sgShrines) {
    if (now < (s.nextReadyAt || 0)) continue;
    let activator = null;
    for (const p of sgPlayers.values()) {
      if (!p.alive || p.spectator) continue;
      if (dst(p.x, p.y, s.x, s.y) <= s.r) {
        activator = p;
        break;
      }
    }
    if (!activator) continue;
    const buffSec = clp(Math.round(Number(sgConfig.shrineBuffSec) || 18), 6, 120);
    const cdSec = clp(Math.round(Number(sgConfig.shrineCooldownSec) || 55), 6, 240);
    sgApplyRelicBuff(activator, s.type, 2, 'shrine');
    // Shrines also hard-set buff duration so admin tune has clear effect.
    const until = now + buffSec * 1000;
    if (s.type === 'fury') activator.furyUntil = Math.max(activator.furyUntil || 0, until);
    if (s.type === 'fortify') activator.fortifyUntil = Math.max(activator.fortifyUntil || 0, until);
    if (s.type === 'swift') activator.swiftUntil = Math.max(activator.swiftUntil || 0, until);
    if (s.type === 'tracker') activator.trackerUntil = Math.max(activator.trackerUntil || 0, until);
    s.nextReadyAt = now + cdSec * 1000;
    s.activations = (s.activations || 0) + 1;
    sgFlagVerShrines();
    sgLog('system', `${activator.name} captured ${sgShrineTemplate(s.type).name}`);
  }
}

function sgTickPassiveRegen(now, dtSec) {
  if (sgMatch.phase !== 'running') return;
  const base = clp(Number(sgConfig.passiveRegenPerSec) || 0, 0, 20);
  if (base <= 0) return;
  const delaySec = clp(Number(sgConfig.combatRegenDelaySec) || 7, 0, 60);
  for (const p of sgPlayers.values()) {
    if (!p.alive || p.spectator) continue;
    if (p.hp >= SG_MAX_HP) continue;
    const damagedAgo = now - (p.lastDamagedAt || 0);
    if (damagedAgo < delaySec * 1000) continue;
    const boost = sgPlayerHasBuff(p, 'renew', now) ? 1.75 : 1;
    p.hp = clp(p.hp + base * boost * dtSec, 1, SG_MAX_HP);
  }
}

function sgStartStorm(now) {
  const minR = Math.max(180, Math.round((Number(sgConfig.stormRadius) || 520) * 0.62));
  const maxR = Math.max(minR + 40, Math.round(Number(sgConfig.stormRadius) || 520));
  const ring = Math.max(260, Math.round(sgMatch.borderRadius * 0.65));
  const a = Math.random() * Math.PI * 2;
  const sx = SG_CENTER.x + Math.cos(a) * ring;
  const sy = SG_CENTER.y + Math.sin(a) * ring;
  const pos = sgFindFreeSpot(sx, sy, 36);
  sgStorm.active = true;
  sgStorm.x = pos.x;
  sgStorm.y = pos.y;
  sgStorm.r = clp(minR + Math.random() * (maxR - minR), 120, 1400);
  sgStorm.startedAt = now;
  sgStorm.endsAt = now + clp(Math.round(Number(sgConfig.stormDurationSec) || 18), 4, 180) * 1000;
  sgStorm.nextAt = 0;
  sgFlagVerStorm();
  sgLog('system', 'Arc storm ignited: avoid the charged zone');
}

function sgStopStorm(now) {
  if (!sgStorm.active) return;
  sgStorm.active = false;
  const everyMs = clp(Math.round(Number(sgConfig.stormEverySec) || 95), 10, 600) * 1000;
  sgStorm.nextAt = now + everyMs;
  sgFlagVerStorm();
  sgLog('system', 'Arc storm dissipated');
}

function sgTickStorm(now, dtSec) {
  if (!sgConfig.stormEnabled || sgMatch.phase !== 'running') {
    if (sgStorm.active) {
      sgStorm.active = false;
      sgFlagVerStorm();
    }
    return;
  }
  if (!sgStorm.nextAt) {
    const everyMs = clp(Math.round(Number(sgConfig.stormEverySec) || 95), 10, 600) * 1000;
    sgStorm.nextAt = now + everyMs;
    sgFlagVerStorm();
  }
  if (!sgStorm.active && now >= sgStorm.nextAt) {
    sgStartStorm(now);
  }
  if (!sgStorm.active) return;
  if (now >= sgStorm.endsAt) {
    sgStopStorm(now);
    return;
  }
  const dps = clp(Number(sgConfig.stormDamagePerSec) || 14, 1, 100);
  for (const p of sgPlayers.values()) {
    if (!p.alive || p.spectator) continue;
    const d = dst(p.x, p.y, sgStorm.x, sgStorm.y);
    if (d > sgStorm.r) continue;
    const mitigation = sgPlayerHasBuff(p, 'fortify', now) ? 0.72 : 1;
    p.hp -= dps * mitigation * dtSec;
    p.lastDamagedAt = now;
    if (p.hp <= 0) sgKillPlayer(p, null, 'storm');
  }
}

function serSgRelics() {
  return sgRelics.map(r => [
    r.id,
    r.type,
    Math.round(r.x),
    Math.round(r.y),
    r.tier | 0,
    r.expiresAt | 0,
  ]);
}

function serSgShrines() {
  return sgShrines.map(s => [
    s.id,
    s.type,
    Math.round(s.x),
    Math.round(s.y),
    Math.round(s.r),
    Math.round(s.nextReadyAt || 0),
    Math.round(s.activations || 0),
  ]);
}

function serSgStorm() {
  return {
    active: sgStorm.active ? 1 : 0,
    x: Math.round(sgStorm.x),
    y: Math.round(sgStorm.y),
    r: Math.round(sgStorm.r),
    startedAt: Math.round(sgStorm.startedAt || 0),
    endsAt: Math.round(sgStorm.endsAt || 0),
    nextAt: Math.round(sgStorm.nextAt || 0),
  };
}

const SG_BOT_NAMES = [
  'Revenant', 'Spartan', 'Ninja', 'Falcon', 'Rogue', 'Titan', 'Specter', 'Nova', 'Brawler', 'Ranger',
  'Shifter', 'Viper', 'Golem', 'Drifter', 'Hunter', 'Prowler', 'Knight', 'Warden', 'Cyclone', 'Raptor',
];

function sgHumanCount(includeSpectators = false) {
  let n = 0;
  for (const p of sgPlayers.values()) {
    if (p.isBot) continue;
    if (!includeSpectators && p.spectator) continue;
    n++;
  }
  return n;
}

function sgBotCount(includeSpectators = false) {
  let n = 0;
  for (const p of sgPlayers.values()) {
    if (!p.isBot) continue;
    if (!includeSpectators && p.spectator) continue;
    n++;
  }
  return n;
}

function sgMkUniqueBotName() {
  for (let attempt = 0; attempt < 120; attempt++) {
    const base = SG_BOT_NAMES[attempt % SG_BOT_NAMES.length];
    const suffix = 10 + ((attempt * 17 + Date.now()) % 89);
    const name = `${base}-${suffix}`;
    let exists = false;
    for (const p of sgPlayers.values()) {
      if (p.name.toLowerCase() === name.toLowerCase()) { exists = true; break; }
    }
    if (!exists) return name;
  }
  return `Bot-${Math.floor(Math.random() * 9999)}`;
}

function sgSpawnBot() {
  const id = `sgb-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const p = {
    id,
    name: sgMkUniqueBotName(),
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
    jumpUntil: 0,
    jumpStartedAt: 0,
    jumpCdUntil: 0,
    jumpImpulseUntil: 0,
    jumpImpulseX: 0,
    jumpImpulseY: 0,
    furyUntil: 0,
    fortifyUntil: 0,
    swiftUntil: 0,
    trackerUntil: 0,
    regenBoostUntil: 0,
    lastDamagedAt: 0,
    lastRelicAt: 0,
    lastAttack: 0,
    lastPing: Date.now(),
    joinTime: Date.now(),
    isBot: true,
    bot: {
      nextThinkAt: 0,
      mx: 0,
      my: 0,
      wanderA: Math.random() * Math.PI * 2,
    },
    device: 'Bot',
  };
  sgResetPlayerForRound(p);
  sgPlayers.set(id, p);
  sgLog('join', `${p.name} joined as bot`);
  return p;
}

function sgRemoveOneBot(reason = 'bot-adjust') {
  for (const p of sgPlayers.values()) {
    if (!p.isBot) continue;
    sgPlayers.delete(p.id);
    sgLog('leave', `${p.name} removed (${reason})`);
    return true;
  }
  return false;
}

function sgEnsureBotFill() {
  if (!sgConfig.botFillEnabled) {
    while (sgRemoveOneBot('bot-fill-disabled')) { /* remove all bots */ }
    return;
  }
  if (sgMatch.phase !== 'lobby' && sgMatch.phase !== 'countdown') return;

  const humans = sgHumanCount(false);
  const bots = sgBotCount(false);
  const targetPlayers = clp(Math.round(Number(sgConfig.botFillTargetPlayers) || 6), 1, 30);
  const maxBots = clp(Math.round(Number(sgConfig.botFillMaxBots) || 8), 0, 20);
  const desiredBots = clp(targetPlayers - humans, 0, maxBots);
  if (bots < desiredBots) {
    for (let i = bots; i < desiredBots; i++) sgSpawnBot();
  } else if (bots > desiredBots) {
    for (let i = desiredBots; i < bots; i++) sgRemoveOneBot('bot-fill-balance');
  }
}

function sgUpdateBotAI(now) {
  const diff = clp(Number(sgConfig.botDifficulty) || 1, 0.2, 3);
  const thinkEvery = clp(360 / diff, 110, 800);
  for (const p of sgPlayers.values()) {
    if (!p.isBot || !p.alive || p.spectator) continue;
    p.lastPing = now;
    if (!p.bot) p.bot = { nextThinkAt: 0, mx: 0, my: 0, wanderA: Math.random() * Math.PI * 2 };
    if (now >= (p.bot.nextThinkAt || 0)) {
      let mx = 0;
      let my = 0;
      let relicTarget = null;
      let relicDist = Infinity;
      if (sgMatch.phase === 'running' && sgRelics.length > 0) {
        for (const r of sgRelics) {
          const d = dst(p.x, p.y, r.x, r.y);
          if (d < relicDist) {
            relicDist = d;
            relicTarget = r;
          }
        }
      }
      const nearest = sgFindNearestEnemy(p);
      if (relicTarget && (p.hp < 65 || Math.random() < 0.24) && relicDist < 620) {
        const tx = relicTarget.x - p.x;
        const ty = relicTarget.y - p.y;
        const dist = Math.max(1, Math.hypot(tx, ty));
        mx = tx / dist;
        my = ty / dist;
      } else if (nearest) {
        const tx = nearest.target.x - p.x;
        const ty = nearest.target.y - p.y;
        const dist = Math.max(1, Math.hypot(tx, ty));
        const close = dist < Math.max(110, Number(sgConfig.attackRange) * 0.95);
        const flee = p.hp < 34 || (nearest.target.weaponTier > p.weaponTier + 1 && p.hp < 70);
        if (flee) {
          mx = -tx / dist;
          my = -ty / dist;
        } else if (close) {
          const perp = Math.random() < 0.5 ? -1 : 1;
          mx = (ty / dist) * perp * 0.64 + (tx / dist) * 0.28;
          my = (-tx / dist) * perp * 0.64 + (ty / dist) * 0.28;
        } else {
          mx = tx / dist;
          my = ty / dist;
        }
      } else {
        p.bot.wanderA += (Math.random() * 0.9 - 0.45);
        mx = Math.cos(p.bot.wanderA);
        my = Math.sin(p.bot.wanderA);
      }
      const mag = Math.max(1e-4, Math.hypot(mx, my));
      p.bot.mx = mx / mag;
      p.bot.my = my / mag;
      p.bot.nextThinkAt = now + thinkEvery + Math.random() * 190;
    }
    p.mx = p.bot.mx || 0;
    p.my = p.bot.my || 0;
    if (Math.hypot(p.mx, p.my) > 1e-3) p.face = Math.atan2(p.my, p.mx);

    if (sgMatch.phase !== 'running') continue;
    if (p.hp < 58 && (p.soups || 0) > 0) sgTrySoup(p);
    if ((p.sneakyCharges || 0) > 0 && Math.random() < 0.0018 * diff) sgTryAbility(p, 'sneaky');
    if ((p.weightlessCharges || 0) > 0 && Math.random() < 0.0018 * diff) sgTryAbility(p, 'weightless');

    const nearest = sgFindNearestEnemy(p);
    if (nearest && nearest.dist < Math.max(90, Number(sgConfig.attackRange) * 1.03)) {
      if (nearest.dist > 85 && nearest.dist < 260 && Math.random() < 0.032 * diff) sgTryJump(p);
      sgTryAttack(p);
    } else if (Math.random() < 0.011 * diff) {
      sgTryOpenChest(p);
      if (Math.random() < 0.18 * diff) sgTryJump(p);
    }
  }
}

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
sgGenerateMap(sgConfig.mapSeed);
sgBuildShrines();

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
  const raw = best ? { x: best.x, y: best.y } : { x: SG_CENTER.x, y: SG_CENTER.y };
  return sgFindFreeSpot(raw.x, raw.y, 22);
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
  p.invulnUntil = Date.now() + clp((Number(sgConfig.spawnInvulnSec) || 0) * 1000, 0, 20000);
  p.invisUntil = 0;
  p.speedUntil = 0;
  p.hitGlowUntil = 0;
  p.nextCompassAt = 0;
  p.nextSneakyAt = 0;
  p.nextWeightlessAt = 0;
  p.jumpUntil = 0;
  p.jumpStartedAt = 0;
  p.jumpCdUntil = 0;
  p.jumpImpulseUntil = 0;
  p.jumpImpulseX = 0;
  p.jumpImpulseY = 0;
  p.furyUntil = 0;
  p.fortifyUntil = 0;
  p.swiftUntil = 0;
  p.trackerUntil = 0;
  p.regenBoostUntil = 0;
  p.lastDamagedAt = 0;
  p.lastRelicAt = 0;
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
  p.jumpUntil = 0;
  p.jumpStartedAt = 0;
  p.jumpCdUntil = 0;
  p.jumpImpulseUntil = 0;
  p.jumpImpulseX = 0;
  p.jumpImpulseY = 0;
  p.furyUntil = 0;
  p.fortifyUntil = 0;
  p.swiftUntil = 0;
  p.trackerUntil = 0;
  p.regenBoostUntil = 0;
  p.lastDamagedAt = 0;
  p.lastRelicAt = 0;
}

function sgResetRound(keepPlayers = true) {
  sgMatch.phase = 'lobby';
  sgMatch.countdownEndsAt = 0;
  sgMatch.startedAt = 0;
  sgMatch.endsAt = 0;
  sgMatch.endedAt = 0;
  sgMatch.winnerId = null;
  sgMatch.endReason = '';
  sgMatch.feastAt = 0;
  sgMatch.feastTriggered = false;
  sgMatch.feastAnnounced = false;
  sgMatch.borderRadius = sgConfig.borderStartRadius;
  sgStorm.active = false;
  sgStorm.startedAt = 0;
  sgStorm.endsAt = 0;
  sgStorm.nextAt = 0;
  sgStorm.x = SG_CENTER.x;
  sgStorm.y = SG_CENTER.y;
  sgStorm.r = clp(Number(sgConfig.stormRadius) || 520, 120, 1400);
  sgFlagVerStorm();
  sgGen++;
  initSurvivalChests();
  sgClearRelics('round-reset');
  sgBuildShrines();
  sgLastRelicSpawnAt = 0;
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
  sgMatch.feastAt = sgMatch.startedAt + Math.max(15, Number(sgConfig.feastTimeSec) || 150) * 1000;
  sgMatch.feastTriggered = false;
  sgMatch.feastAnnounced = false;
  sgMatch.borderRadius = sgConfig.borderStartRadius;
  sgClearRelics('match-start');
  sgLastRelicSpawnAt = sgMatch.startedAt;
  sgBuildShrines();
  const stormEveryMs = clp(Math.round(Number(sgConfig.stormEverySec) || 95), 10, 600) * 1000;
  sgStorm.active = false;
  sgStorm.startedAt = 0;
  sgStorm.endsAt = 0;
  sgStorm.nextAt = sgMatch.startedAt + stormEveryMs;
  sgStorm.x = SG_CENTER.x;
  sgStorm.y = SG_CENTER.y;
  sgStorm.r = clp(Number(sgConfig.stormRadius) || 520, 120, 1400);
  sgFlagVerStorm();
  for (const p of sgPlayers.values()) {
    if (!p.spectator) sgResetPlayerForRound(p);
    else sgSetSpectator(p);
  }
  sgSpawnRelicWave(2);
  sgLog('system', 'Survival Games match started');
}

function sgEndMatch(winnerId, reason) {
  if (sgMatch.phase === 'ended') return;
  sgMatch.phase = 'ended';
  sgMatch.endedAt = Date.now();
  sgMatch.winnerId = winnerId || null;
  sgMatch.endReason = String(reason || '').slice(0, 60);
  sgClearRelics('match-end');
  if (sgStorm.active) {
    sgStorm.active = false;
    sgStorm.startedAt = 0;
    sgStorm.endsAt = 0;
    sgStorm.nextAt = 0;
    sgFlagVerStorm();
  }
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

function sgTriggerFeast() {
  if (sgMatch.phase !== 'running' || sgMatch.feastTriggered) return;
  const need = clp(Math.round(Number(sgConfig.feastChestCount) || 7), 1, sgChests.length);
  const ranked = [...sgChests].sort((a, b) => {
    const da = dst(a.x, a.y, SG_CENTER.x, SG_CENTER.y);
    const db = dst(b.x, b.y, SG_CENTER.x, SG_CENTER.y);
    return da - db;
  });
  for (let i = 0; i < need; i++) {
    const c = ranked[i];
    c.openedAt = 0;
    c.nextRefillAt = 0;
  }
  sgMatch.feastTriggered = true;
  sgChestVer++;
  sgLog('system', 'Feast event is LIVE at center chests');
}

function sgKillPlayer(victim, killer, cause) {
  if (!victim.alive) return;
  const now = Date.now();
  victim.alive = false;
  victim.hp = 0;
  victim.invisUntil = 0;
  victim.speedUntil = 0;
  victim.jumpUntil = 0;
  victim.jumpStartedAt = 0;
  victim.jumpCdUntil = 0;
  victim.jumpImpulseUntil = 0;
  victim.jumpImpulseX = 0;
  victim.jumpImpulseY = 0;
  victim.furyUntil = 0;
  victim.fortifyUntil = 0;
  victim.swiftUntil = 0;
  victim.trackerUntil = 0;
  victim.regenBoostUntil = 0;
  victim.lastDamagedAt = now;
  victim.deaths = (victim.deaths || 0) + 1;
  if (killer && killer.id !== victim.id) killer.kills = (killer.kills || 0) + 1;
  if (sgConfig.relicsEnabled && sgMatch.phase === 'running' && Math.random() < 0.22) {
    const pos = sgFindFreeSpot(victim.x, victim.y, 20);
    const deathRelic = {
      id: `rel-${now}-${Math.random().toString(36).slice(2, 6)}`,
      type: Math.random() < 0.5 ? 'renew' : 'fortify',
      x: pos.x,
      y: pos.y,
      tier: 2,
      spawnAt: now,
      expiresAt: now + clp(Math.round(Number(sgConfig.relicLifetimeSec) || 75), 10, 500) * 1000,
    };
    sgRelics.push(deathRelic);
    sgFlagVerRelics();
  }
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
  const trackerBuff = sgPlayerHasBuff(player, 'tracker', now);
  if ((player.compassCharges || 0) <= 0 && !trackerBuff) return false;
  if (now < (player.nextCompassAt || 0)) return false;
  const nearest = sgFindNearestEnemy(player);
  if (!nearest) return false;

  if (!trackerBuff || (player.compassCharges || 0) > 0) {
    player.compassCharges = Math.max(0, (player.compassCharges || 0) - 1);
  }
  const cdBase = Math.max(1, sgConfig.compassCooldownSec) * 1000;
  player.nextCompassAt = now + (trackerBuff ? Math.round(cdBase * 0.62) : cdBase);
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
  const now = Date.now();
  if (!player || !player.alive || player.spectator) return false;
  if ((player.soups || 0) <= 0) return false;
  if (player.hp >= SG_MAX_HP) return false;
  player.soups--;
  const heal = (Number(sgConfig.soupHeal) || 32) * (sgPlayerHasBuff(player, 'renew', now) ? 1.2 : 1);
  player.hp = clp(player.hp + heal, 1, SG_MAX_HP);
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

function sgTryJump(player) {
  const now = Date.now();
  if (!player || !player.alive || player.spectator) return false;
  if (sgMatch.phase !== 'lobby' && sgMatch.phase !== 'countdown' && sgMatch.phase !== 'running') return false;
  if (now < (player.jumpCdUntil || 0)) return false;

  const jumpDurationMs = clp(Math.round(Number(sgConfig.jumpDurationMs) || 540), 180, 1500);
  const jumpCdMs = clp(Math.round((Number(sgConfig.jumpCooldownSec) || 1.1) * 1000), 200, 5000);
  let ix = Number(player.mx) || 0;
  let iy = Number(player.my) || 0;
  const mag = Math.hypot(ix, iy);
  if (mag > 1e-3) {
    ix /= mag;
    iy /= mag;
  } else {
    const f = Number.isFinite(player.face) ? player.face : 0;
    ix = Math.cos(f);
    iy = Math.sin(f);
  }

  player.jumpStartedAt = now;
  player.jumpUntil = now + jumpDurationMs;
  player.jumpCdUntil = now + jumpCdMs;
  player.jumpImpulseUntil = now + Math.floor(jumpDurationMs * 0.48);
  player.jumpImpulseX = ix;
  player.jumpImpulseY = iy;
  if (now < (player.invisUntil || 0)) player.invisUntil = 0;
  return true;
}

function sgTryAttack(attacker) {
  const now = Date.now();
  if (sgMatch.phase !== 'running') return;
  if (!attacker || !attacker.alive || attacker.spectator) return;
  if (now < (attacker.invisUntil || 0)) attacker.invisUntil = 0; // attacking breaks invis
  if (now < attacker.invulnUntil) return;
  const attackCd = Math.round((Number(sgConfig.attackCooldownMs) || 700) * (sgPlayerHasBuff(attacker, 'fury', now) ? 0.88 : 1));
  if (now - (attacker.lastAttack || 0) < attackCd) return;
  if (now < sgMatch.startedAt + sgConfig.graceSec * 1000) return;
  attacker.lastAttack = now;

  const range = Math.max(40, Number(sgConfig.attackRange) || 130);
  const fovDeg = clp(Number(sgConfig.attackFovDeg) || 155, 20, 360);
  const halfFov = (fovDeg * Math.PI / 180) * 0.5;
  let target = null;
  let best = Infinity;
  for (const p of sgPlayers.values()) {
    if (p.id === attacker.id || !p.alive || p.spectator) continue;
    if (now < p.invulnUntil) continue;
    const d = dst(attacker.x, attacker.y, p.x, p.y);
    if (sgSegmentBlocked(attacker.x, attacker.y, p.x, p.y, 3)) continue;
    const attackFace = Number.isFinite(attacker.face) ? attacker.face : 0;
    const aim = Math.atan2(p.y - attacker.y, p.x - attacker.x);
    const diff = Math.atan2(Math.sin(aim - attackFace), Math.cos(aim - attackFace));
    if (Math.abs(diff) > halfFov) continue;
    if (d < range && d < best) { best = d; target = p; }
  }
  if (!target) return;

  const lunge = clp(Number(sgConfig.attackLunge) || 26, 0, 120);
  if (lunge > 0) {
    const lx = target.x - attacker.x;
    const ly = target.y - attacker.y;
    const lm = Math.hypot(lx, ly);
    if (lm > 1e-4) {
      attacker.x += (lx / lm) * lunge;
      attacker.y += (ly / lm) * lunge;
      sgClampPos(attacker);
      sgResolveMapCollision(attacker, 18);
    }
  }

  const baseDamage = Number(sgConfig.baseDamage) || 22;
  const furyBoost = sgPlayerHasBuff(attacker, 'fury', now) ? 1.28 : 1;
  const fortifyMitigation = sgPlayerHasBuff(target, 'fortify', now) ? 0.74 : 1;
  const trackerPrecision = sgPlayerHasBuff(attacker, 'tracker', now) ? 1.08 : 1;
  const variance = 0.88 + Math.random() * 0.28;
  const raw =
    (baseDamage + attacker.weaponTier * 7 - target.armorTier * 5) *
    furyBoost *
    trackerPrecision *
    variance *
    fortifyMitigation;
  const dmg = clp(raw, 5, 95);
  target.hp -= dmg;
  const kb = clp(Number(sgConfig.knockback) || 90, 0, 400);
  if (kb > 0) {
    const dx = target.x - attacker.x;
    const dy = target.y - attacker.y;
    const mag = Math.hypot(dx, dy);
    if (mag > 1e-4) {
      target.x += (dx / mag) * kb;
      target.y += (dy / mag) * kb;
      sgClampPos(target);
    }
  }
  target.hitGlowUntil = now + 900;
  target.lastDamagedAt = now;
  if (target.hp <= 0) sgKillPlayer(target, attacker, 'melee');
}

function sgTryOpenChest(player) {
  const now = Date.now();
  if (!player || !player.alive || player.spectator) return false;
  if (sgMatch.phase !== 'running') return false;
  const openRange = Math.max(30, Number(sgConfig.chestOpenRange) || 95);

  // If a relic is nearby, opening action picks the relic first.
  let relic = null;
  let relicIdx = -1;
  let bestRelic = Infinity;
  for (let i = 0; i < sgRelics.length; i++) {
    const r = sgRelics[i];
    const d = dst(player.x, player.y, r.x, r.y);
    if (d < openRange && d < bestRelic) {
      bestRelic = d;
      relic = r;
      relicIdx = i;
    }
  }
  if (relic && relicIdx >= 0) {
    sgApplyRelicBuff(player, relic.type, relic.tier, 'manual-pickup');
    sgRelics.splice(relicIdx, 1);
    sgFlagVerRelics();
    sgLog('loot', `${player.name} claimed ${sgRelicTemplate(relic.type).name}`);
    return true;
  }

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
  let tier = roll < tier3Chance ? 3 : roll < tier3Chance + tier2Chance ? 2 : 1;
  if (sgMatch.phase === 'running' && sgMatch.feastTriggered && distToCenter < 650) tier = Math.max(tier, 3);

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

  if (sgConfig.relicsEnabled && Math.random() < (tier === 3 ? 0.34 : tier === 2 ? 0.18 : 0.06)) {
    const pos = sgFindFreeSpot(chest.x + (Math.random() * 90 - 45), chest.y + (Math.random() * 90 - 45), 18);
    const relicType = pick(SG_RELIC_TYPES).id;
    const relic = {
      id: `rel-${now}-${Math.random().toString(36).slice(2, 6)}`,
      type: relicType,
      x: pos.x,
      y: pos.y,
      tier: tier >= 3 ? 3 : tier >= 2 ? 2 : 1,
      spawnAt: now,
      expiresAt: now + clp(Math.round(Number(sgConfig.relicLifetimeSec) || 75), 10, 500) * 1000,
    };
    sgRelics.push(relic);
    sgFlagVerRelics();
    lootSummary.push(`✨${sgRelicTemplate(relicType).name}`);
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
    if (p.isBot) continue;
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

  sgEnsureBotFill();
  sgUpdateBotAI(now);

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
  }

  const canMove = sgMatch.phase === 'lobby' || sgMatch.phase === 'countdown' || sgMatch.phase === 'running';
  if (canMove) {
    if (sgMatch.phase === 'running') {
      sgUpdateBorder(now);
      if (sgConfig.feastEnabled) {
        const leadSec = Math.max(3, Math.round(Number(sgConfig.feastAnnounceLeadSec) || 25));
        if (!sgMatch.feastAnnounced && now >= sgMatch.feastAt - leadSec * 1000 && now < sgMatch.feastAt) {
          sgMatch.feastAnnounced = true;
          sgLog('system', `Feast opens in ${Math.max(0, Math.ceil((sgMatch.feastAt - now) / 1000))}s at center`);
        }
        if (!sgMatch.feastTriggered && now >= sgMatch.feastAt) {
          sgTriggerFeast();
        }
      }
      sgTickRelics(now);
      sgTickShrines(now);
    }

    // Movement should work in lobby/countdown/running for better playability.
    for (const p of sgPlayers.values()) {
      if (!p.alive || p.spectator) continue;
      const mag = Math.hypot(p.mx || 0, p.my || 0);
      if (mag > 1e-3) {
        const nx = (p.mx || 0) / mag;
        const ny = (p.my || 0) / mag;
        const speedBoostActive = now < (p.speedUntil || 0);
        const swiftBoostActive = sgPlayerHasBuff(p, 'swift', now);
        let speedMult = speedBoostActive ? (Number(sgConfig.speedBoostMultiplier) || 1.55) : 1;
        if (swiftBoostActive) speedMult *= 1.18;
        p.x += nx * sgConfig.moveSpeed * speedMult * dtSec;
        p.y += ny * sgConfig.moveSpeed * speedMult * dtSec;
      }
      if (now < (p.jumpImpulseUntil || 0)) {
        const jumpImpulse = clp(Number(sgConfig.jumpImpulseSpeed) || 540, 120, 1800);
        p.x += (p.jumpImpulseX || 0) * jumpImpulse * dtSec;
        p.y += (p.jumpImpulseY || 0) * jumpImpulse * dtSec;
      }
      sgResolveMapCollision(p, 18);
      sgClampPos(p);
      if (sgMatch.phase === 'running') {
        const dd = dst(p.x, p.y, SG_CENTER.x, SG_CENTER.y);
        if (dd > sgMatch.borderRadius) {
          const fortifyMitigation = sgPlayerHasBuff(p, 'fortify', now) ? 0.78 : 1;
          const jumpMitigation = now < (p.jumpUntil || 0) ? 0.82 : 1;
          p.hp -= sgConfig.borderDamagePerSec * fortifyMitigation * jumpMitigation * dtSec;
          p.lastDamagedAt = now;
          if (p.hp <= 0) sgKillPlayer(p, null, 'border');
        }
      }
    }
  }

  if (sgMatch.phase === 'running') {
    sgTickStorm(now, dtSec);
    sgTickPassiveRegen(now, dtSec);
  }

  if (sgMatch.phase === 'running') {
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
  const feastRemaining = sgConfig.feastEnabled && sgMatch.phase === 'running' && !sgMatch.feastTriggered
    ? Math.max(0, Math.ceil((sgMatch.feastAt - now) / 1000))
    : 0;
  return {
    phase: sgMatch.phase,
    countdownRemaining,
    graceRemaining,
    endRemaining,
    feastRemaining,
    feastTriggered: !!sgMatch.feastTriggered,
    borderRadius: Math.round(sgMatch.borderRadius),
    winnerId: sgMatch.winnerId,
    endReason: sgMatch.endReason,
    startedAt: sgMatch.startedAt,
    relicCount: sgRelics.length,
    shrineCount: sgShrines.length,
    storm: serSgStorm(),
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
      p.isBot ? 1 : 0,
      p.jumpUntil || 0,
      p.jumpStartedAt || 0,
      p.jumpCdUntil || 0,
      p.furyUntil || 0,
      p.fortifyUntil || 0,
      p.swiftUntil || 0,
      p.trackerUntil || 0,
      p.regenBoostUntil || 0,
      p.lastDamagedAt || 0,
      p.lastRelicAt || 0,
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

function serSgMap() {
  return {
    ver: sgMapVer,
    seed: sgMap.seed,
    p: serSgMapProps(),
    poi: serSgPois(),
  };
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
  for (const [ws, conn] of connections) {
    if (conn.sgPlayerId && ws.readyState === 1) {
      safeSend(ws, data);
    }
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
      jumpUntil: p.jumpUntil || 0,
      jumpStartedAt: p.jumpStartedAt || 0,
      jumpCdUntil: p.jumpCdUntil || 0,
      furyUntil: p.furyUntil || 0,
      fortifyUntil: p.fortifyUntil || 0,
      swiftUntil: p.swiftUntil || 0,
      trackerUntil: p.trackerUntil || 0,
      regenBoostUntil: p.regenBoostUntil || 0,
      lastDamagedAt: p.lastDamagedAt || 0,
      lastRelicAt: p.lastRelicAt || 0,
      isBot: !!p.isBot,
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
    mapVer: sgMapVer,
    mapSeed: sgMap.seed,
    mapObstacleCount: sgMap.props.length,
    mapPoiCount: sgMap.pois.length,
    relicCount: sgRelics.length,
    relicVer: sgRelicVer,
    shrineCount: sgShrines.length,
    shrineVer: sgShrineVer,
    stormVer: sgStormVer,
    storm: serSgStorm(),
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
  const conn = { playerId: null, sgPlayerId: null, tkPlayerId: null, isAdmin: false, adminGame: 'agar', ip };
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
    if (conn.tkPlayerId) {
      tkLeave(conn);
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
    jumpUntil: 0,
    jumpStartedAt: 0,
    jumpCdUntil: 0,
    jumpImpulseUntil: 0,
    jumpImpulseX: 0,
    jumpImpulseY: 0,
    furyUntil: 0,
    fortifyUntil: 0,
    swiftUntil: 0,
    trackerUntil: 0,
    regenBoostUntil: 0,
    lastDamagedAt: 0,
    lastRelicAt: 0,
    lastAttack: 0,
    lastPing: Date.now(),
    joinTime: Date.now(),
    device: parseDevice(msg.ua || 'Unknown'),
  };

  const aliveNow = sgAlivePlayers().length;
  if (sgMatch.phase === 'running' && sgConfig.lateJoinAsSpectator && aliveNow >= 2) sgSetSpectator(p);
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
    mv: sgMapVer,
    ms: sgMap.seed,
    mp: serSgMapProps(),
    poi: serSgPois(),
    rv: sgRelicVer,
    r: serSgRelics(),
    sv: sgShrineVer,
    sh: serSgShrines(),
    stv: sgStormVer,
    st: serSgStorm(),
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
  const prevMapSeed = sgConfig.mapSeed;
  const prevMapDensity = sgConfig.mapPropDensity;
  const prevMapObstacleCount = sgConfig.mapObstacleCount;
  const prevMapLaneWidth = sgConfig.mapLaneWidth;
  const prevMapSizeVariance = sgConfig.mapSizeVariance;
  const prevShrineEnabled = !!sgConfig.shrineEnabled;
  const prevShrineCount = Number(sgConfig.shrineCount) || 0;
  const prevShrineRadius = Number(sgConfig.shrineRadius) || 0;
  const numeric = [
    'minPlayersToStart', 'countdownSec', 'graceSec', 'matchDurationSec',
    'moveSpeed', 'jumpCooldownSec', 'jumpDurationMs', 'jumpImpulseSpeed',
    'attackCooldownMs', 'attackRange', 'attackFovDeg', 'baseDamage', 'knockback', 'attackLunge', 'spawnInvulnSec',
    'soupHeal', 'compassCooldownSec', 'invisDurationSec', 'invisCooldownSec',
    'speedBoostMultiplier', 'speedBoostDurationSec', 'speedBoostCooldownSec',
    'feastTimeSec', 'feastAnnounceLeadSec', 'feastChestCount',
    'mapSeed', 'mapPropDensity', 'mapObstacleCount', 'mapLaneWidth', 'mapSizeVariance',
    'botFillTargetPlayers', 'botFillMaxBots', 'botDifficulty',
    'relicSpawnIntervalSec', 'relicLifetimeSec', 'relicMaxActive', 'relicPickupRange',
    'shrineCount', 'shrineRadius', 'shrineBuffSec', 'shrineCooldownSec',
    'passiveRegenPerSec', 'combatRegenDelaySec',
    'stormEverySec', 'stormDurationSec', 'stormRadius', 'stormDamagePerSec',
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
  if (msg.feastEnabled !== undefined) sgConfig.feastEnabled = !!msg.feastEnabled;
  if (msg.botFillEnabled !== undefined) sgConfig.botFillEnabled = !!msg.botFillEnabled;
  if (msg.relicsEnabled !== undefined) sgConfig.relicsEnabled = !!msg.relicsEnabled;
  if (msg.shrineEnabled !== undefined) sgConfig.shrineEnabled = !!msg.shrineEnabled;
  if (msg.stormEnabled !== undefined) sgConfig.stormEnabled = !!msg.stormEnabled;

  sgConfig.minPlayersToStart = clp(Math.round(sgConfig.minPlayersToStart), 1, 50);
  sgConfig.countdownSec = clp(Math.round(sgConfig.countdownSec), 3, 60);
  sgConfig.graceSec = clp(Math.round(sgConfig.graceSec), 0, 120);
  sgConfig.matchDurationSec = clp(Math.round(sgConfig.matchDurationSec), 30, 1800);
  sgConfig.moveSpeed = clp(sgConfig.moveSpeed, 80, 1200);
  sgConfig.jumpCooldownSec = clp(sgConfig.jumpCooldownSec, 0.2, 5);
  sgConfig.jumpDurationMs = clp(Math.round(sgConfig.jumpDurationMs), 180, 1500);
  sgConfig.jumpImpulseSpeed = clp(sgConfig.jumpImpulseSpeed, 120, 1800);
  sgConfig.attackCooldownMs = clp(Math.round(sgConfig.attackCooldownMs), 150, 5000);
  sgConfig.attackRange = clp(sgConfig.attackRange, 30, 400);
  sgConfig.attackFovDeg = clp(sgConfig.attackFovDeg, 20, 360);
  sgConfig.baseDamage = clp(sgConfig.baseDamage, 1, 120);
  sgConfig.knockback = clp(sgConfig.knockback, 0, 400);
  sgConfig.attackLunge = clp(sgConfig.attackLunge, 0, 120);
  sgConfig.spawnInvulnSec = clp(sgConfig.spawnInvulnSec, 0, 20);
  sgConfig.soupHeal = clp(sgConfig.soupHeal, 1, 100);
  sgConfig.compassCooldownSec = clp(Math.round(sgConfig.compassCooldownSec), 1, 120);
  sgConfig.invisDurationSec = clp(Math.round(sgConfig.invisDurationSec), 1, 60);
  sgConfig.invisCooldownSec = clp(Math.round(sgConfig.invisCooldownSec), 1, 240);
  sgConfig.speedBoostMultiplier = clp(sgConfig.speedBoostMultiplier, 1.01, 4);
  sgConfig.speedBoostDurationSec = clp(Math.round(sgConfig.speedBoostDurationSec), 1, 60);
  sgConfig.speedBoostCooldownSec = clp(Math.round(sgConfig.speedBoostCooldownSec), 1, 240);
  sgConfig.feastTimeSec = clp(Math.round(sgConfig.feastTimeSec), 15, 1200);
  sgConfig.feastAnnounceLeadSec = clp(Math.round(sgConfig.feastAnnounceLeadSec), 3, 180);
  sgConfig.feastChestCount = clp(Math.round(sgConfig.feastChestCount), 1, sgChests.length);
  sgConfig.mapSeed = Math.max(1, Math.floor(Math.abs(sgConfig.mapSeed || 1337)));
  sgConfig.mapPropDensity = clp(sgConfig.mapPropDensity, 0.35, 2.8);
  sgConfig.mapObstacleCount = clp(Math.round(sgConfig.mapObstacleCount), 40, 500);
  sgConfig.mapLaneWidth = clp(Math.round(sgConfig.mapLaneWidth), 50, 280);
  sgConfig.mapSizeVariance = clp(sgConfig.mapSizeVariance, 0.5, 1.8);
  sgConfig.botFillTargetPlayers = clp(Math.round(sgConfig.botFillTargetPlayers), 1, 30);
  sgConfig.botFillMaxBots = clp(Math.round(sgConfig.botFillMaxBots), 0, 20);
  sgConfig.botDifficulty = clp(sgConfig.botDifficulty, 0.2, 3);
  sgConfig.relicSpawnIntervalSec = clp(Math.round(sgConfig.relicSpawnIntervalSec), 4, 240);
  sgConfig.relicLifetimeSec = clp(Math.round(sgConfig.relicLifetimeSec), 10, 500);
  sgConfig.relicMaxActive = clp(Math.round(sgConfig.relicMaxActive), 1, 30);
  sgConfig.relicPickupRange = clp(sgConfig.relicPickupRange, 24, 200);
  sgConfig.shrineCount = clp(Math.round(sgConfig.shrineCount), 0, 16);
  sgConfig.shrineRadius = clp(sgConfig.shrineRadius, 45, 220);
  sgConfig.shrineBuffSec = clp(Math.round(sgConfig.shrineBuffSec), 6, 120);
  sgConfig.shrineCooldownSec = clp(Math.round(sgConfig.shrineCooldownSec), 6, 240);
  sgConfig.passiveRegenPerSec = clp(sgConfig.passiveRegenPerSec, 0, 20);
  sgConfig.combatRegenDelaySec = clp(sgConfig.combatRegenDelaySec, 0, 60);
  sgConfig.stormEverySec = clp(Math.round(sgConfig.stormEverySec), 10, 600);
  sgConfig.stormDurationSec = clp(Math.round(sgConfig.stormDurationSec), 4, 180);
  sgConfig.stormRadius = clp(Math.round(sgConfig.stormRadius), 120, 1400);
  sgConfig.stormDamagePerSec = clp(sgConfig.stormDamagePerSec, 1, 100);
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

  const mapChanged = sgConfig.mapSeed !== prevMapSeed ||
    Math.abs((sgConfig.mapPropDensity || 0) - (prevMapDensity || 0)) > 1e-9 ||
    sgConfig.mapObstacleCount !== prevMapObstacleCount ||
    sgConfig.mapLaneWidth !== prevMapLaneWidth ||
    Math.abs((sgConfig.mapSizeVariance || 0) - (prevMapSizeVariance || 0)) > 1e-9;
  if (mapChanged) {
    sgGenerateMap(sgConfig.mapSeed);
    sgBuildShrines();
    sgLog('system', `Map regenerated (seed ${sgConfig.mapSeed}, props ${sgMap.props.length})`);
  }

  const shrineChanged =
    !!sgConfig.shrineEnabled !== prevShrineEnabled ||
    (Number(sgConfig.shrineCount) || 0) !== prevShrineCount ||
    Math.abs((Number(sgConfig.shrineRadius) || 0) - prevShrineRadius) > 1e-9;
  if (!mapChanged && shrineChanged) {
    sgBuildShrines();
  }

  // Trim relic pool if admin reduced the cap.
  const maxRelics = clp(Math.round(Number(sgConfig.relicMaxActive) || 9), 1, 30);
  if (sgRelics.length > maxRelics) {
    sgRelics = sgRelics.slice(0, maxRelics);
    sgFlagVerRelics();
  }

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
    // ---- Survival Games Jump ----
    case 'sgjump': {
      if (!conn.sgPlayerId) break;
      sgTryJump(sgPlayers.get(conn.sgPlayerId));
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
    // ---- Survival Games Admin Map Regenerate ----
    case 'sgmap': {
      if (!conn.isAdmin || conn.adminGame !== 'survival-games') return;
      if (msg.seed !== undefined) {
        const v = Number(msg.seed);
        if (Number.isFinite(v)) sgConfig.mapSeed = Math.max(1, Math.floor(Math.abs(v)));
      }
      sgGenerateMap(sgConfig.mapSeed);
      sgBuildShrines();
      sgClearRelics('map-regenerated');
      sgLog('system', `Map regenerated by admin (seed ${sgConfig.mapSeed})`);
      broadcastSurvival(JSON.stringify({
        t: 'sgmap',
        mv: sgMapVer,
        ms: sgMap.seed,
        mp: serSgMapProps(),
        poi: serSgPois(),
        sv: sgShrineVer,
        sh: serSgShrines(),
        rv: sgRelicVer,
        r: serSgRelics(),
      }));
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'survival_admin_map_regen' }));
      break;
    }
    // ---- Survival Games Admin Spawn Relic Wave ----
    case 'sgrelicwave': {
      if (!conn.isAdmin || conn.adminGame !== 'survival-games') return;
      const count = clp(Math.round(Number(msg.count) || 3), 1, 12);
      sgSpawnRelicWave(count);
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'survival_admin_relic_wave' }));
      break;
    }
    // ---- Survival Games Admin Clear Relics ----
    case 'sgrelicclear': {
      if (!conn.isAdmin || conn.adminGame !== 'survival-games') return;
      sgClearRelics('admin-clear');
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'survival_admin_relic_clear' }));
      break;
    }
    // ---- Survival Games Admin Rebuild Shrines ----
    case 'sgshrine': {
      if (!conn.isAdmin || conn.adminGame !== 'survival-games') return;
      sgBuildShrines();
      sgLog('system', 'Shrines rebuilt by admin');
      safeSend(ws, JSON.stringify({ t: 'am', ok: 1, action: 'survival_admin_shrine_rebuild' }));
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
    // ---- Tank 1990 ----
    case 'join-lobby': { tkJoin(ws, conn, msg); break; }
    case 'team-select': { tkHandleTeam(conn, msg); break; }
    case 'ready': { tkHandleReady(conn, msg); break; }
    case 'input': { tkHandleInput(conn, msg); break; }
    case 'tkl': { tkLeave(conn); break; }
    case 'ping': {
      if (msg.v === 1) safeSend(ws, JSON.stringify({ v: 1, t: 'pong', sentAt: msg.sentAt, serverAt: Date.now() }));
      break;
    }
  }
}

// ============================================================================
// GAME LOOP & BROADCAST
// ============================================================================
const TICK_RATE = 60;
const BROADCAST_RATE = 30;
let tickCount = 0;
let lastBroadcastFv = -1;
let lastBroadcastVv = -1;
let lastBroadcastMv = -1;

setInterval(() => {
  if (serverPaused) return; // skip everything when paused
  const t0 = performance.now();
  tick();
  sgTick();
  tkTick();
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
    tkBroadcastState();
    tkFlushLobby();
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
  if (sgMapVer !== sgLastBroadcastMapVer) {
    state.mv = sgMapVer;
    state.ms = sgMap.seed;
    state.mp = serSgMapProps();
    state.poi = serSgPois();
    sgLastBroadcastMapVer = sgMapVer;
  }
  if (sgRelicVer !== sgLastBroadcastRelicVer) {
    state.rv = sgRelicVer;
    state.r = serSgRelics();
    sgLastBroadcastRelicVer = sgRelicVer;
  }
  if (sgShrineVer !== sgLastBroadcastShrineVer) {
    state.sv = sgShrineVer;
    state.sh = serSgShrines();
    sgLastBroadcastShrineVer = sgShrineVer;
  }
  if (sgStormVer !== sgLastBroadcastStormVer) {
    state.stv = sgStormVer;
    state.st = serSgStorm();
    sgLastBroadcastStormVer = sgStormVer;
  }
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
// TANK 1990 — Online Multiplayer
// ============================================================================
const TK_PROTOCOL = 1;
const TK_TANK_RADIUS = 0.34;
const TK_BULLET_RADIUS = 0.12;
const TK_BULLET_LIFETIME = 2.8;
const TK_TANK_HP = 100;
const TK_DEFAULT_LIVES = 3;
const TK_BASE_DMG = 18;
const TK_DMG_VARIANCE = 0.25;
const TK_CRIT_CHANCE = 0.15;
const TK_CRIT_MUL = 2.2;
const TK_CLOSE_RANGE_DIST = 4;
const TK_CLOSE_RANGE_MUL = 1.35;
const TK_MOVE_SPEED = 9;
const TK_MOVE_SCALE = 0.62;
const TK_TURN_DEG = 360;
const TK_TURN_SCALE = 0.6;
const TK_ALIGN_TOL = 0.18;
const TK_BULLET_SPEED = 15;
const TK_BULLET_SCALE = 0.88;
const TK_BULLET_CD = 520;
const TK_MAX_BULLETS = 1;
const TK_RESPAWN_SEC = 2;
const TK_SPAWN_PROT_SEC = 2;
const TK_EAGLE_HP = 12;
const TK_EAGLE_HIT_R = 1.28;
const TK_EAGLE_COL_R = 1.45;
const TK_BOT_THINK_MIN = 220;
const TK_BOT_THINK_MAX = 460;
const TK_MATCH_SEC = 300;
const TK_MAX_DT = 0.05;
const TK_AUTO_RESET_MS = 8000;
const TK_COUNTDOWN_MS = 3000;
const TK_FORT_RINGS = 3;
const TK_FORT_DENSITY = 1.25;
const TK_FORT_STEEL = 0.32;

const TK_TILE = {
  '.': { bt: false, bb: false, dest: false, ice: false, water: false },
  B:   { bt: true,  bb: true,  dest: true,  ice: false, water: false },
  S:   { bt: true,  bb: true,  dest: false, ice: false, water: false },
  W:   { bt: false, bb: false, dest: false, ice: false, water: true  },
  T:   { bt: false, bb: false, dest: false, ice: false, water: false },
  I:   { bt: false, bb: false, dest: false, ice: true,  water: false },
};

const tkMapSrc = require('./tank-maps/classic-iron-cross.json');
const tkPlayers = new Map();
let tkBullets = [];
let tkEagles = [];
let tkTiles = [];
let tkTileChanges = [];
let tkPendingEvents = [];
let tkLastTick = Date.now();
let tkTickN = 0;
let tkNextBulletId = 1;
const tkBotNames = ['Bolt', 'Rivet', 'Cannon', 'Razor', 'Viper', 'Titan'];

const tkMatch = {
  phase: 'lobby', hostId: null, countdownAt: 0, startedAt: 0, elapsed: 0,
  endedAt: 0, winnerId: null, winnerTeam: null, endReason: '',
};

// -- Helpers --
function tkClp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function tkDSq(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }
function tkDamp(cur, tgt, lam, dt) { return cur + (tgt - cur) * (1 - Math.exp(-lam * dt)); }
function tkAngLerp(from, to, maxD) {
  let d = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  d = tkClp(d, -maxD, maxD);
  return from + d;
}
function tkAngDiff(a, b) { return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))); }
function tkHash2(x, y) { const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123; return v - Math.floor(v); }
function tkCIR(cx, cy, r, rx, ry, rw, rh) {
  const nx = tkClp(cx, rx, rx + rw), ny = tkClp(cy, ry, ry + rh);
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}
function tkUid() { return `tk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

function tkGetTile(x, y) {
  if (y < 0 || y >= tkTiles.length || x < 0 || x >= (tkTiles[0] || []).length) return null;
  return tkTiles[y][x];
}
function tkSetTile(x, y, code) {
  if (y < 0 || y >= tkTiles.length || x < 0 || x >= (tkTiles[0] || []).length) return;
  tkTiles[y][x] = code;
  tkTileChanges.push({ x, y, c: code });
}

function tkCountBricks() {
  let n = 0;
  for (const row of tkTiles) for (const c of row) if (c === 'B') n++;
  return n;
}

// -- Collision --
function tkBlocked(tank, x, y) {
  const R = TK_TANK_RADIUS, W = tkMapSrc.width, H = tkMapSrc.height;
  if (x - R < 0 || x + R > W || y - R < 0 || y + R > H) return true;
  const mnX = Math.floor(x - R), mxX = Math.floor(x + R);
  const mnY = Math.floor(y - R), mxY = Math.floor(y + R);
  for (let ty = mnY; ty <= mxY; ty++) for (let tx = mnX; tx <= mxX; tx++) {
    const c = tkGetTile(tx, ty);
    if (!c) return true;
    if (TK_TILE[c] && TK_TILE[c].bt && tkCIR(x, y, R, tx, ty, 1, 1)) return true;
  }
  for (const e of tkEagles) {
    if (!e.alive) continue;
    if (tkDSq(x, y, e.x, e.y) < (R + TK_EAGLE_COL_R) ** 2) return true;
  }
  for (const [, o] of tkPlayers) {
    if (!o.alive || o.id === tank.id || o.spectator) continue;
    if (tkDSq(x, y, o.x, o.y) < (R * 2) ** 2 * 0.82) return true;
  }
  return false;
}

function tkTryMove(tank, dx, dy) {
  if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) return true;
  const tx = tank.x + dx, ty = tank.y + dy;
  if (tkBlocked(tank, tx, ty)) return false;
  tank.x = tkClp(tx, TK_TANK_RADIUS, tkMapSrc.width - TK_TANK_RADIUS);
  tank.y = tkClp(ty, TK_TANK_RADIUS, tkMapSrc.height - TK_TANK_RADIUS);
  return true;
}

function tkAlignLane(tank, ax, ay, dt) {
  if (ax !== 0 && ay === 0) {
    const lane = Math.round(tank.y - 0.5) + 0.5;
    const ny = tkDamp(tank.y, lane, 24, dt);
    if (!tkBlocked(tank, tank.x, ny)) tank.y = ny;
  } else if (ay !== 0 && ax === 0) {
    const lane = Math.round(tank.x - 0.5) + 0.5;
    const nx = tkDamp(tank.x, lane, 24, dt);
    if (!tkBlocked(tank, nx, tank.y)) tank.x = nx;
  }
}

// -- Tank Step --
function tkStepTank(tank, now, dt) {
  const inp = tank.input;
  let ax = 0, ay = 0;
  if (inp.left) ax -= 1; if (inp.right) ax += 1;
  if (inp.up) ay -= 1; if (inp.down) ay += 1;
  const wants = ax !== 0 || ay !== 0;
  if (Math.abs(ax) > Math.abs(ay)) ay = 0; else if (Math.abs(ay) > Math.abs(ax)) ax = 0;
  const desired = wants ? Math.atan2(ay, ax) : tank.dir;
  if (wants) tkAlignLane(tank, ax, ay, dt);
  const turnRad = (TK_TURN_DEG * TK_TURN_SCALE * Math.PI) / 180;
  if (wants) tank.dir = tkAngLerp(tank.dir, desired, turnRad * dt);
  if (wants && tkAngDiff(tank.dir, desired) < 0.02) tank.dir = desired;

  const tx = Math.floor(tank.x), ty = Math.floor(tank.y);
  const tc = tkGetTile(tx, ty);
  const meta = tc ? TK_TILE[tc] : null;
  const onIce = meta ? meta.ice : false;
  const onWater = meta ? meta.water : false;
  const wPen = onWater ? 0.38 : 1;
  const spd = TK_MOVE_SPEED * TK_MOVE_SCALE * wPen * (onIce ? 1.12 : 1);
  const canGo = wants && tkAngDiff(tank.dir, desired) <= TK_ALIGN_TOL;

  if (canGo) {
    if (onIce) {
      tank.vx = tkDamp(tank.vx, Math.cos(tank.dir) * spd, 8.2, dt);
      tank.vy = tkDamp(tank.vy, Math.sin(tank.dir) * spd, 8.2, dt);
    } else { tank.vx = Math.cos(tank.dir) * spd; tank.vy = Math.sin(tank.dir) * spd; }
  } else {
    if (onIce) { tank.vx = tkDamp(tank.vx, 0, 2.8, dt); tank.vy = tkDamp(tank.vy, 0, 2.8, dt); }
    else { tank.vx = 0; tank.vy = 0; }
  }
  if (!tkTryMove(tank, tank.vx * dt, 0)) tank.vx *= 0.2;
  if (!tkTryMove(tank, 0, tank.vy * dt)) tank.vy *= 0.2;
}

// -- Bullets --
function tkTryFire(tank, now) {
  if (!tank.alive || now < tank.fireCD) return;
  const inFlight = tkBullets.filter(b => b.ownerId === tank.id && b.life > 0).length;
  if (inFlight >= TK_MAX_BULLETS) return;
  const sx = tank.x + Math.cos(tank.dir) * (TK_TANK_RADIUS + 0.22);
  const sy = tank.y + Math.sin(tank.dir) * (TK_TANK_RADIUS + 0.22);
  tkBullets.push({
    id: `b${tkNextBulletId++}`, ownerId: tank.id,
    x: sx, y: sy, dx: Math.cos(tank.dir), dy: Math.sin(tank.dir),
    speed: TK_BULLET_SPEED * TK_BULLET_SCALE, life: TK_BULLET_LIFETIME, ric: 0,
  });
  tank.fireCD = now + TK_BULLET_CD;
  tkPendingEvents.push({ t: 'fire', id: tank.id, x: sx, y: sy, dir: tank.dir });
}

function tkBulletHitTile(b, px, py) {
  const tx = Math.floor(b.x), ty = Math.floor(b.y);
  const c = tkGetTile(tx, ty);
  if (!c) { b.life = -1; return true; }
  const m = TK_TILE[c];
  if (!m || !m.bb) return false;
  if (m.dest) {
    tkSetTile(tx, ty, '.');
    b.life = -1;
    const owner = tkPlayers.get(b.ownerId);
    if (owner) owner.score += 0.2;
    tkPendingEvents.push({ t: 'brick', x: tx + 0.5, y: ty + 0.5 });
    return true;
  }
  if (b.ric > 0) {
    b.ric--;
    const ptx = Math.floor(px), pty = Math.floor(py);
    const cx = ptx !== tx, cy = pty !== ty;
    if (cx) b.dx *= -1; if (cy) b.dy *= -1;
    if (!cx && !cy) { if (Math.abs(b.dx) > Math.abs(b.dy)) b.dx *= -1; else b.dy *= -1; }
    return true;
  }
  b.life = -1; return true;
}

function tkBulletHitTank(b, now) {
  const owner = tkPlayers.get(b.ownerId);
  for (const [, tank] of tkPlayers) {
    if (!tank.alive || tank.id === b.ownerId || tank.spectator) continue;
    if (owner && owner.team !== 'none' && tank.team === owner.team) continue;
    if (now < tank.spawnProt) continue;
    if (tkDSq(tank.x, tank.y, b.x, b.y) > (TK_TANK_RADIUS + TK_BULLET_RADIUS) ** 2) continue;
    b.life = -1;
    const variance = 1 + (Math.random() * 2 - 1) * TK_DMG_VARIANCE;
    const isCrit = Math.random() < TK_CRIT_CHANCE;
    const critM = isCrit ? TK_CRIT_MUL : 1;
    const dist = owner ? Math.sqrt(tkDSq(owner.x, owner.y, tank.x, tank.y)) : 999;
    const rangeM = dist < TK_CLOSE_RANGE_DIST ? TK_CLOSE_RANGE_MUL : 1;
    const dmg = Math.round(tkClp(TK_BASE_DMG * variance * critM * rangeM, 1, 100));
    tank.hp -= dmg;
    tkPendingEvents.push({ t: 'hit', x: b.x, y: b.y, dmg, crit: isCrit, tid: tank.id, oid: b.ownerId });
    if (tank.hp <= 0) {
      tank.hp = 0; tank.lives--; tank.alive = false;
      tank.respawnAt = now + TK_RESPAWN_SEC * 1000;
      if (owner) owner.score += 1;
      if (tank.lives <= 0) tank.spawnProt = 0;
      tkPendingEvents.push({ t: 'kill', x: tank.x, y: tank.y, tid: tank.id, oid: b.ownerId, color: tank.color });
    }
    return true;
  }
  return false;
}

function tkBulletHitEagle(b, now) {
  const owner = tkPlayers.get(b.ownerId);
  if (!owner || owner.team === 'none') return false;
  for (const e of tkEagles) {
    if (!e.alive || e.team === owner.team) continue;
    if (tkDSq(e.x, e.y, b.x, b.y) > (TK_EAGLE_HIT_R + TK_BULLET_RADIUS) ** 2) continue;
    b.life = -1;
    e.hp = Math.max(0, e.hp - 1);
    tkPendingEvents.push({ t: 'eagle-hit', x: b.x, y: b.y, eid: e.id, ehp: e.hp });
    if (e.hp <= 0) {
      e.alive = false; owner.score += 6;
      tkPendingEvents.push({ t: 'eagle-kill', x: e.x, y: e.y, eid: e.id, team: e.team });
    } else { owner.score += 0.4; }
    return true;
  }
  return false;
}

function tkStepBullets(now, dt) {
  const W = tkMapSrc.width, H = tkMapSrc.height;
  for (const b of tkBullets) {
    if (b.life <= 0) continue;
    let rem = b.speed * dt;
    while (rem > 0 && b.life > 0) {
      const seg = Math.min(0.18, rem);
      const px = b.x, py = b.y;
      b.x += b.dx * seg; b.y += b.dy * seg;
      b.life -= seg / b.speed; rem -= seg;
      if (b.x < 0 || b.x > W || b.y < 0 || b.y > H) { b.life = -1; break; }
      if (tkBulletHitTile(b, px, py)) break;
      if (tkBulletHitTank(b, now)) break;
      if (tkBulletHitEagle(b, now)) break;
    }
  }
}

function tkResolveBvB() {
  for (let i = 0; i < tkBullets.length; i++) {
    const a = tkBullets[i]; if (a.life <= 0) continue;
    for (let j = i + 1; j < tkBullets.length; j++) {
      const b = tkBullets[j]; if (b.life <= 0 || a.ownerId === b.ownerId) continue;
      if (tkDSq(a.x, a.y, b.x, b.y) <= (TK_BULLET_RADIUS * 2.3) ** 2) {
        tkPendingEvents.push({ t: 'impact', x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 });
        a.life = -1; b.life = -1; break;
      }
    }
  }
}

function tkCleanBullets() {
  tkBullets = tkBullets.filter(b => b.life > 0);
}

// -- Bot AI --
function tkPickTarget(bot) {
  let best = null, bestD = Infinity;
  for (const [, p] of tkPlayers) {
    if (!p.alive || p.id === bot.id || p.spectator) continue;
    if (bot.team !== 'none' && p.team === bot.team) continue;
    const d = tkDSq(bot.x, bot.y, p.x, p.y);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best;
}

function tkEnemyEagle(team) {
  return tkEagles.find(e => e.alive && e.team !== team) || null;
}

function tkLineOfFire(fx, fy, tx, ty) {
  const dx = tx - fx, dy = ty - fy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 0.1) return true;
  const nx = dx / dist, ny = dy / dist;
  const steps = Math.ceil(dist / 0.2);
  let x = fx, y = fy;
  for (let i = 0; i < steps; i++) {
    x += nx * 0.2; y += ny * 0.2;
    const c = tkGetTile(Math.floor(x), Math.floor(y));
    if (!c) return false;
    if (TK_TILE[c] && TK_TILE[c].bb) return false;
  }
  return true;
}

function tkBotAI(now) {
  for (const [, p] of tkPlayers) {
    if (!p.isBot || !p.alive || p.spectator) continue;
    p.lastPing = now;
    if (!p.bot) p.bot = { thinkAt: 0, mx: 0, my: 0, fireUntil: 0 };
    if (now >= p.bot.thinkAt) {
      p.bot.thinkAt = now + TK_BOT_THINK_MIN + Math.random() * (TK_BOT_THINK_MAX - TK_BOT_THINK_MIN);
      const tgt = tkPickTarget(p);
      const eagle = tkEnemyEagle(p.team);
      const tgtX = tgt ? tgt.x : eagle ? eagle.x : undefined;
      const tgtY = tgt ? tgt.y : eagle ? eagle.y : undefined;
      if (tgtX === undefined) { p.bot.mx = 0; p.bot.my = 0; p.bot.fireUntil = 0; }
      else {
        const dx = tgtX - p.x, dy = tgtY - p.y;
        if (Math.abs(dx) > Math.abs(dy)) { p.bot.mx = Math.sign(dx); p.bot.my = 0; }
        else { p.bot.mx = 0; p.bot.my = Math.sign(dy); }
        const aligned = Math.abs(dx) < 0.42 || Math.abs(dy) < 0.42;
        const lof = aligned && (tgt ? tkLineOfFire(p.x, p.y, tgt.x, tgt.y) : eagle ? tkLineOfFire(p.x, p.y, eagle.x, eagle.y) : false);
        p.bot.fireUntil = lof ? now + 140 : 0;
      }
      if (Math.random() < 0.08) {
        if (Math.random() < 0.5) { p.bot.mx = Math.random() < 0.5 ? -1 : 1; p.bot.my = 0; }
        else { p.bot.mx = 0; p.bot.my = Math.random() < 0.5 ? -1 : 1; }
      }
    }
    p.input = { up: p.bot.my < 0, down: p.bot.my > 0, left: p.bot.mx < 0, right: p.bot.mx > 0, fire: now < p.bot.fireUntil };
  }
}

// -- Respawn --
function tkRespawn(tank, now) {
  if (tank.alive || tank.lives <= 0 || now < tank.respawnAt) return;
  const spawns = tkMapSrc.spawns.filter(s =>
    tank.team === 'red' ? s.x <= tkMapSrc.width / 2 : s.x >= tkMapSrc.width / 2
  );
  const pool = spawns.length > 0 ? spawns : tkMapSrc.spawns;
  const start = Math.floor(Math.random() * pool.length);
  for (let i = 0; i < pool.length; i++) {
    const s = pool[(start + i) % pool.length];
    if (!tkBlocked(tank, s.x, s.y)) {
      tank.x = s.x; tank.y = s.y;
      tank.dir = ((s.headingDeg || 0) * Math.PI) / 180;
      tank.hp = TK_TANK_HP; tank.alive = true;
      tank.spawnProt = now + TK_SPAWN_PROT_SEC * 1000;
      tank.vx = 0; tank.vy = 0; tank.fireCD = 0;
      return;
    }
  }
  // Fallback: scatter around a random spawn if all exact points are occupied
  const s = pool[start];
  for (let a = 0; a < 20; a++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = TK_TANK_RADIUS * 2.5 + Math.random() * 2.5;
    const fx = s.x + Math.cos(angle) * dist;
    const fy = s.y + Math.sin(angle) * dist;
    if (!tkBlocked(tank, fx, fy)) {
      tank.x = fx; tank.y = fy;
      tank.dir = ((s.headingDeg || 0) * Math.PI) / 180;
      tank.hp = TK_TANK_HP; tank.alive = true;
      tank.spawnProt = now + TK_SPAWN_PROT_SEC * 1000;
      tank.vx = 0; tank.vy = 0; tank.fireCD = 0;
      return;
    }
  }
}

// -- Eagle Fortress --
function tkGetAnchors() {
  const margin = tkClp(4.4 + TK_FORT_RINGS * 0.9, 3.8, tkMapSrc.width * 0.38);
  return { lx: margin, rx: tkMapSrc.width - margin, y: tkMapSrc.height * 0.5 };
}

function tkBuildFort() {
  const { lx, rx, y } = tkGetAnchors();
  const specs = [{ team: 'red', x: lx, y }, { team: 'blue', x: rx, y }];
  const rings = TK_FORT_RINGS, dens = TK_FORT_DENSITY, steel = TK_FORT_STEEL;
  const gateH = Math.max(1, Math.round(0.7 + dens * 0.7));
  for (const sp of specs) {
    const cx = Math.floor(sp.x), cy = Math.floor(sp.y);
    for (let r = 1; r <= rings + 1; r++) {
      const span = 2 + r;
      for (let ty = cy - span; ty <= cy + span; ty++) for (let tx = cx - span; tx <= cx + span; tx++) {
        if (tx <= 0 || ty <= 0 || tx >= tkMapSrc.width - 1 || ty >= tkMapSrc.height - 1) continue;
        if (Math.abs(tx - cx) !== span && Math.abs(ty - cy) !== span) continue;
        const gateFace = sp.team === 'red' ? tx === cx + span : tx === cx - span;
        if (gateFace && Math.abs(ty - cy) <= gateH && r >= rings) { tkSetTile(tx, ty, '.'); continue; }
        if (Math.abs(tx - cx) <= 1 && Math.abs(ty - cy) <= 1) continue;
        const n = tkHash2(tx * 2.31 + r * 9.11 + (sp.team === 'red' ? 3.7 : 8.2), ty * 3.12 + r * 4.87);
        if (n > tkClp(0.56 + dens * 0.27, 0.45, 0.96)) continue;
        tkSetTile(tx, ty, n <= tkClp(steel + (r === rings + 1 ? 0.14 : 0), 0.05, 0.95) ? 'S' : 'B');
      }
    }
    const rubble = Math.round(4 + dens * 5);
    for (let i = 0; i < rubble; i++) {
      const ox = Math.floor((tkHash2(i * 7.1 + cx, cy * 1.3 + i) - 0.5) * 5);
      const oy = Math.floor((tkHash2(i * 9.7 + cy, cx * 1.9 + i) - 0.5) * 5);
      const ttx = cx + ox, tty = cy + oy;
      if (ttx <= 1 || tty <= 1 || ttx >= tkMapSrc.width - 1 || tty >= tkMapSrc.height - 1) continue;
      if (Math.abs(ttx - cx) <= 1 && Math.abs(tty - cy) <= 1) continue;
      if (tkGetTile(ttx, tty) === '.') tkSetTile(ttx, tty, 'B');
    }
  }
}

// -- Win Check --
function tkTeamScore(team) {
  let s = 0;
  for (const [, p] of tkPlayers) if (p.team === team && !p.spectator) s += p.score;
  return s;
}
function tkTeamLeader(team) {
  let best = null, bs = -1;
  for (const [, p] of tkPlayers) {
    if (p.team !== team || p.spectator) continue;
    if (p.score > bs || (p.score === bs && p.alive)) { best = p.id; bs = p.score; }
  }
  return best;
}

function tkCheckWin(now) {
  if (tkMatch.phase !== 'running') return;
  const re = tkEagles.find(e => e.team === 'red');
  const be = tkEagles.find(e => e.team === 'blue');
  if (re && be) {
    if (!re.alive && be.alive) { tkEndMatch(tkTeamLeader('blue'), 'blue', 'eagle-destroyed'); return; }
    if (!be.alive && re.alive) { tkEndMatch(tkTeamLeader('red'), 'red', 'eagle-destroyed'); return; }
    if (!re.alive && !be.alive) {
      const w = tkTeamScore('red') >= tkTeamScore('blue') ? 'red' : 'blue';
      tkEndMatch(tkTeamLeader(w), w, 'both-eagles'); return;
    }
  }
  if (tkMatch.elapsed >= TK_MATCH_SEC) {
    const rh = re ? re.hp : 0, bh = be ? be.hp : 0;
    let w;
    if (rh !== bh) w = rh > bh ? 'red' : 'blue';
    else w = tkTeamScore('red') >= tkTeamScore('blue') ? 'red' : 'blue';
    tkEndMatch(tkTeamLeader(w), w, 'time'); return;
  }
  const rAlive = [...tkPlayers.values()].some(p => p.team === 'red' && !p.spectator && (p.alive || p.lives > 0));
  const bAlive = [...tkPlayers.values()].some(p => p.team === 'blue' && !p.spectator && (p.alive || p.lives > 0));
  if (!rAlive && bAlive) tkEndMatch(tkTeamLeader('blue'), 'blue', 'eliminated');
  else if (rAlive && !bAlive) tkEndMatch(tkTeamLeader('red'), 'red', 'eliminated');
}

// -- Lobby & Match --
function tkSpawnBot(name) {
  const id = tkUid();
  const redCount = [...tkPlayers.values()].filter(p => p.team === 'red' && !p.spectator).length;
  const blueCount = [...tkPlayers.values()].filter(p => p.team === 'blue' && !p.spectator).length;
  const team = redCount <= blueCount ? 'red' : 'blue';
  const color = team === 'red' ? '#f87171' : '#60a5fa';
  tkPlayers.set(id, {
    id, name, team, color, isBot: true, spectator: false, ws: null,
    x: 0, y: 0, dir: 0, hp: TK_TANK_HP, lives: TK_DEFAULT_LIVES, score: 0,
    alive: false, respawnAt: 0, spawnProt: 0, fireCD: 0, vx: 0, vy: 0,
    input: { up: false, down: false, left: false, right: false, fire: false },
    lastSeq: 0, lastPing: Date.now(), bot: null,
  });
}

function tkEnsureBots() {
  if (tkMatch.phase !== 'lobby') return;
  const humans = [...tkPlayers.values()].filter(p => !p.isBot && !p.spectator).length;
  const bots = [...tkPlayers.values()].filter(p => p.isBot).length;
  const desired = Math.max(0, 4 - humans);
  if (bots < desired) {
    for (let i = bots; i < desired; i++) tkSpawnBot(tkBotNames[i % tkBotNames.length]);
  } else if (bots > desired) {
    let rem = bots - desired;
    for (const [id, p] of tkPlayers) {
      if (rem <= 0) break;
      if (p.isBot) { tkPlayers.delete(id); rem--; }
    }
  }
  tkBalanceTeams();
}

function tkBalanceTeams() {
  const players = [...tkPlayers.values()].filter(p => !p.spectator);
  const red = players.filter(p => p.team === 'red');
  const blue = players.filter(p => p.team === 'blue');
  while (red.length > blue.length + 1) {
    const bot = red.find(p => p.isBot) || red[red.length - 1];
    bot.team = 'blue'; bot.color = bot.isBot ? '#60a5fa' : '#3b82f6';
    red.splice(red.indexOf(bot), 1); blue.push(bot);
  }
  while (blue.length > red.length + 1) {
    const bot = blue.find(p => p.isBot) || blue[blue.length - 1];
    bot.team = 'red'; bot.color = bot.isBot ? '#f87171' : '#ef4444';
    blue.splice(blue.indexOf(bot), 1); red.push(bot);
  }
}

function tkSpawnPlayer(p) {
  const spawns = tkMapSrc.spawns.filter(s =>
    p.team === 'red' ? s.x <= tkMapSrc.width / 2 : s.x >= tkMapSrc.width / 2
  );
  const pool = spawns.length > 0 ? spawns : tkMapSrc.spawns;
  const start = Math.floor(Math.random() * pool.length);
  let placed = false;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[(start + i) % pool.length];
    if (!tkBlocked(p, s.x, s.y)) {
      p.x = s.x; p.y = s.y;
      p.dir = ((s.headingDeg || 0) * Math.PI) / 180;
      placed = true;
      break;
    }
  }
  if (!placed) {
    // Fallback: scatter outward from each spawn until a clear spot is found
    const attempts = 30;
    outer: for (const s of pool) {
      for (let a = 0; a < attempts; a++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = TK_TANK_RADIUS * 2.5 + Math.random() * 2.5;
        const fx = s.x + Math.cos(angle) * dist;
        const fy = s.y + Math.sin(angle) * dist;
        if (!tkBlocked(p, fx, fy)) {
          p.x = fx; p.y = fy;
          p.dir = ((s.headingDeg || 0) * Math.PI) / 180;
          placed = true;
          break outer;
        }
      }
    }
    if (!placed) {
      // Last resort: use first spawn position regardless
      const s = pool[start];
      p.x = s.x; p.y = s.y;
      p.dir = ((s.headingDeg || 0) * Math.PI) / 180;
    }
  }
  p.hp = TK_TANK_HP; p.lives = TK_DEFAULT_LIVES; p.score = 0;
  p.alive = true; p.spawnProt = Date.now() + TK_SPAWN_PROT_SEC * 1000;
  p.vx = 0; p.vy = 0; p.fireCD = 0; p.respawnAt = 0;
}

function tkStartCountdown() {
  if (tkMatch.phase !== 'lobby') return;
  tkMatch.phase = 'countdown';
  tkMatch.countdownAt = Date.now() + TK_COUNTDOWN_MS;
  tkBroadcastLobby();
}

function tkStartMatch() {
  tkMatch.phase = 'running';
  tkMatch.startedAt = Date.now();
  tkMatch.elapsed = 0;
  tkMatch.winnerId = null; tkMatch.winnerTeam = null; tkMatch.endReason = '';
  tkBullets = []; tkPendingEvents = []; tkTileChanges = []; tkNextBulletId = 1;
  tkTiles = tkMapSrc.rows.map(r => r.split(''));
  tkBuildFort();
  const anch = tkGetAnchors();
  tkEagles = [
    { id: 'eagle-red', team: 'red', x: anch.lx, y: anch.y, hp: TK_EAGLE_HP, maxHp: TK_EAGLE_HP, alive: true },
    { id: 'eagle-blue', team: 'blue', x: anch.rx, y: anch.y, hp: TK_EAGLE_HP, maxHp: TK_EAGLE_HP, alive: true },
  ];
  for (const [, p] of tkPlayers) {
    if (p.spectator) continue;
    tkSpawnPlayer(p);
  }
  // Send full initial state
  const initMsg = JSON.stringify({
    v: 1, t: 'match-start',
    tiles: tkTiles.map(r => r.join('')),
    eagles: tkEagles.map(e => ({ id: e.id, team: e.team, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp })),
    map: { id: tkMapSrc.id, width: tkMapSrc.width, height: tkMapSrc.height, tileSize: tkMapSrc.tileSize,
           spawns: tkMapSrc.spawns, theme: tkMapSrc.theme, elevation: tkMapSrc.elevation,
           objectives: tkMapSrc.objectives || [], hazards: tkMapSrc.hazards || [] },
    players: [...tkPlayers.values()].filter(p => !p.spectator).map(p => ({
      id: p.id, name: p.name, team: p.team, color: p.color, isBot: p.isBot,
      x: p.x, y: p.y, dir: p.dir, hp: p.hp, lives: p.lives,
    })),
  });
  for (const [, p] of tkPlayers) {
    if (p.ws && p.ws.readyState === 1) safeSend(p.ws, initMsg);
  }
}

function tkEndMatch(winnerId, winnerTeam, reason) {
  if (tkMatch.phase !== 'running') return;
  tkMatch.phase = 'ended'; tkMatch.endedAt = Date.now();
  tkMatch.winnerId = winnerId; tkMatch.winnerTeam = winnerTeam; tkMatch.endReason = reason;
  const winnerP = tkPlayers.get(winnerId);
  tkBroadcastAll(JSON.stringify({
    v: 1, t: 'match-ended', winnerId, winnerTeam, reason,
    winnerName: winnerP ? winnerP.name : null,
  }));
}

function tkResetLobby() {
  tkMatch.phase = 'lobby'; tkMatch.hostId = null;
  tkBullets = []; tkEagles = []; tkTileChanges = []; tkPendingEvents = [];
  // Convert spectators to active, replace bots
  for (const [, p] of tkPlayers) {
    if (p.spectator && !p.isBot) {
      p.spectator = false;
      // Remove a bot to make room
      for (const [bid, bp] of tkPlayers) {
        if (bp.isBot) { tkPlayers.delete(bid); break; }
      }
    }
    p.alive = false; p.score = 0; p.lives = TK_DEFAULT_LIVES; p.hp = TK_TANK_HP;
  }
  // Set host to first human
  for (const [, p] of tkPlayers) {
    if (!p.isBot && !p.spectator) { tkMatch.hostId = p.id; break; }
  }
  tkEnsureBots();
  tkBroadcastLobby();
}

// -- Message Handlers --
function tkJoin(ws, conn, msg) {
  // Leave other games
  if (conn.playerId) { players.delete(conn.playerId); conn.playerId = null; }
  if (conn.sgPlayerId) { sgPlayers.delete(conn.sgPlayerId); conn.sgPlayerId = null; }

  const name = String(msg.playerName || 'Tank').trim().slice(0, 20) || 'Tank';
  const id = tkUid();
  const isSpectator = tkMatch.phase === 'running' || tkMatch.phase === 'countdown';
  const prefTeam = msg.preferredTeam === 'blue' ? 'blue' : 'red';
  const redC = [...tkPlayers.values()].filter(p => p.team === 'red' && !p.spectator).length;
  const blueC = [...tkPlayers.values()].filter(p => p.team === 'blue' && !p.spectator).length;
  const team = isSpectator ? 'red' : (prefTeam === 'red' && redC <= blueC) || (prefTeam === 'blue' && blueC > redC) ? 'red'
    : prefTeam === 'blue' ? 'blue' : redC <= blueC ? 'red' : 'blue';
  const color = team === 'red' ? '#ef4444' : '#3b82f6';

  const p = {
    id, name, team, color, isBot: false, spectator: isSpectator, ws,
    x: 0, y: 0, dir: 0, hp: TK_TANK_HP, lives: TK_DEFAULT_LIVES, score: 0,
    alive: false, respawnAt: 0, spawnProt: 0, fireCD: 0, vx: 0, vy: 0,
    input: { up: false, down: false, left: false, right: false, fire: false },
    lastSeq: 0, lastPing: Date.now(), bot: null,
  };
  tkPlayers.set(id, p);
  conn.tkPlayerId = id;

  if (!isSpectator && !tkMatch.hostId) tkMatch.hostId = id;

  safeSend(ws, JSON.stringify({
    v: 1, t: 'welcome', sessionId: tkUid(), playerId: id,
    isSpectator, hostId: tkMatch.hostId,
  }));

  if (isSpectator && tkMatch.phase === 'running') {
    // Send match-start so they can render
    safeSend(ws, JSON.stringify({
      v: 1, t: 'match-start',
      tiles: tkTiles.map(r => r.join('')),
      eagles: tkEagles.map(e => ({ id: e.id, team: e.team, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp })),
      map: { id: tkMapSrc.id, width: tkMapSrc.width, height: tkMapSrc.height, tileSize: tkMapSrc.tileSize,
             spawns: tkMapSrc.spawns, theme: tkMapSrc.theme, elevation: tkMapSrc.elevation,
             objectives: tkMapSrc.objectives || [], hazards: tkMapSrc.hazards || [] },
      players: [...tkPlayers.values()].filter(pp => !pp.spectator).map(pp => ({
        id: pp.id, name: pp.name, team: pp.team, color: pp.color, isBot: pp.isBot,
        x: pp.x, y: pp.y, dir: pp.dir, hp: pp.hp, lives: pp.lives,
      })),
    }));
  }

  if (!isSpectator) tkEnsureBots();
  tkBroadcastLobby();
}

function tkLeave(conn) {
  const id = conn.tkPlayerId;
  if (!id) return;
  const p = tkPlayers.get(id);
  if (p && p.id === tkMatch.hostId) {
    const next = [...tkPlayers.values()].find(pp => !pp.isBot && pp.id !== id && !pp.spectator);
    tkMatch.hostId = next ? next.id : null;
  }
  tkPlayers.delete(id);
  conn.tkPlayerId = null;
  if (tkMatch.phase === 'lobby') tkEnsureBots();
  tkBroadcastLobby();
}

function tkHandleTeam(conn, msg) {
  if (tkMatch.phase !== 'lobby') return;
  const p = tkPlayers.get(conn.tkPlayerId);
  if (!p || p.isBot || p.spectator) return;
  const team = msg.team === 'blue' ? 'blue' : 'red';
  p.team = team;
  p.color = team === 'red' ? '#ef4444' : '#3b82f6';
  tkBalanceTeams();
  tkBroadcastLobby();
}

function tkHandleReady(conn, msg) {
  if (tkMatch.phase !== 'lobby') return;
  if (conn.tkPlayerId !== tkMatch.hostId) return;
  if (msg.ready) tkStartCountdown();
}

function tkHandleInput(conn, msg) {
  const p = tkPlayers.get(conn.tkPlayerId);
  if (!p || p.isBot || p.spectator) return;
  const inp = msg.input;
  if (!inp || typeof inp !== 'object') return;
  p.input = { up: !!inp.up, down: !!inp.down, left: !!inp.left, right: !!inp.right, fire: !!inp.fire };
  p.lastSeq = msg.seq || 0;
  p.lastPing = Date.now();
}

// -- Broadcast --
function tkBroadcastAll(raw) {
  for (const [, p] of tkPlayers) {
    if (p.ws && p.ws.readyState === 1) safeSend(p.ws, raw);
  }
}

let tkLobbyDirty = false;
function tkBroadcastLobby() {
  tkLobbyDirty = true;
}
function tkFlushLobby() {
  if (!tkLobbyDirty) return;
  tkLobbyDirty = false;
  const players = [...tkPlayers.values()].filter(p => !p.spectator).map(p => ({
    id: p.id, name: p.name, team: p.team, isBot: p.isBot, ready: false,
  }));
  const spectators = [...tkPlayers.values()].filter(p => p.spectator).map(p => ({
    id: p.id, name: p.name,
  }));
  const msg = JSON.stringify({
    v: 1, t: 'lobby-state', phase: tkMatch.phase, hostId: tkMatch.hostId,
    countdownAt: tkMatch.countdownAt, players, spectators,
  });
  tkBroadcastAll(msg);
}

function tkBuildSnapshot() {
  const now = Date.now();
  const tanks = [];
  for (const [, p] of tkPlayers) {
    if (p.spectator) continue;
    tanks.push([
      p.id, p.name, p.team,
      Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100,
      Math.round(p.dir * 1000) / 1000,
      p.hp, p.lives, Math.round(p.score * 10) / 10,
      p.isBot ? 1 : 0, now < p.spawnProt ? 1 : 0, p.alive ? 1 : 0,
      p.color,
    ]);
  }
  const bullets = tkBullets.filter(b => b.life > 0).map(b => [
    b.id, b.ownerId,
    Math.round(b.x * 100) / 100, Math.round(b.y * 100) / 100,
    Math.round(b.dx * 1000) / 1000, Math.round(b.dy * 1000) / 1000,
  ]);
  const eagles = tkEagles.map(e => [e.id, e.team, e.x, e.y, e.hp, e.maxHp, e.alive ? 1 : 0]);
  return { tick: tkTickN, elapsed: Math.round(tkMatch.elapsed * 10) / 10,
    tanks, bullets, eagles, bricks: tkCountBricks(), phase: tkMatch.phase,
    winnerId: tkMatch.winnerId, winnerTeam: tkMatch.winnerTeam };
}

function tkBroadcastState() {
  if (tkMatch.phase !== 'running') return;
  const snap = tkBuildSnapshot();
  const tc = tkTileChanges.length > 0 ? tkTileChanges : undefined;
  const ev = tkPendingEvents.length > 0 ? tkPendingEvents : undefined;

  for (const [, p] of tkPlayers) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const msg = { v: 1, t: 'snapshot', ackSeq: p.lastSeq, snapshot: snap };
    if (tc) msg.tc = tc;
    if (ev) msg.ev = ev;
    safeSend(p.ws, JSON.stringify(msg));
  }
  tkTileChanges = [];
  tkPendingEvents = [];
}

// -- Tick --
function tkTick() {
  const now = Date.now();
  let dms = now - tkLastTick;
  if (dms < 15) return;
  if (dms > 500) dms = 500;
  tkLastTick = now;
  const dt = Math.min(dms / 1000, TK_MAX_DT);

  // Cleanup disconnected
  for (const [id, p] of tkPlayers) {
    if (p.isBot) continue;
    if (!p.ws || p.ws.readyState !== 1) {
      if (p.id === tkMatch.hostId) {
        const next = [...tkPlayers.values()].find(pp => !pp.isBot && pp.id !== id && !pp.spectator && pp.ws && pp.ws.readyState === 1);
        tkMatch.hostId = next ? next.id : null;
      }
      tkPlayers.delete(id);
      if (tkMatch.phase === 'lobby') tkEnsureBots();
      tkBroadcastLobby();
    }
  }

  if (tkMatch.phase === 'lobby') return;
  if (tkMatch.phase === 'countdown') {
    if (now >= tkMatch.countdownAt) tkStartMatch();
    return;
  }
  if (tkMatch.phase === 'ended') {
    if (now - tkMatch.endedAt >= TK_AUTO_RESET_MS) tkResetLobby();
    return;
  }

  // Running
  tkMatch.elapsed += dt;
  tkTickN++;
  tkBotAI(now);
  for (const [, p] of tkPlayers) {
    if (p.spectator) continue;
    if (!p.alive) { tkRespawn(p, now); continue; }
    tkStepTank(p, now, dt);
    if (p.input.fire) tkTryFire(p, now);
  }
  tkStepBullets(now, dt);
  tkResolveBvB();
  tkCleanBullets();
  tkCheckWin(now);
}

// ============================================================================
// START
// ============================================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Abod.io WebSocket server running on port ${PORT}`);
  console.log(`   HTTP status: http://localhost:${PORT}/status`);
  console.log(`   WebSocket:   ws://localhost:${PORT}`);
});
