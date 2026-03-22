// Bot d'automatisation des vaisseaux — mode Attaque/Conquête
// Stratégie : cibler les planètes ennemies par HP croissant, attaquer, puis conquérir
// Reste éloigné des vaisseaux ennemis.

import { doAction, getShips, getMap } from "./api.js";
import { state } from "./state.js";
import { notify } from "./ui.js";
import { getRole, Role } from "./assignments.js";

// ── Constantes ────────────────────────────────────────────────
const TICK_MS               = 3_000;
const CHUNK                 = 18;
const MAP_SIZE              = 58;
const STUCK_THRESHOLD       = 3;
const DIST_WEIGHT           = 0.3;
const FULL_SCAN_COOLDOWN_MS = 60_000;

const Phase = Object.freeze({
    SEARCH:       "SEARCH",
    MOVE:         "MOVE",
    ATTACK:       "ATTACK",
    WAIT_CONQUER: "WAIT_CONQUER",
    CONQUER:      "CONQUER",
});

// ── Cache planètes ─────────────────────────────────────────────
// Clé "x_y" → { x, y, hp, ownerId, immune, stuckCount, lastSeen }
const planetCache = new Map();
const skippedPlanets = new Set();
const claimedTargets = new Map(); // key → shipId

// ── Cache vaisseaux ennemis ────────────────────────────────────
// Clé "x_y" → { x, y, teamId, lastSeen }
const enemyCache = new Map();
const ENEMY_STALE_MS    = 10_000;
const ENEMY_RISK_RADIUS = 3;
const ENEMY_RISK_PENALTY = 200;

// ── Cases réservées par les vaisseaux alliés ce tick ─────────
const reservedCells = new Set();

// ── État par vaisseau ─────────────────────────────────────────
// shipId → { phase, target, lastAttackTime, hpBeforeAttack }
const shipState = new Map();

// ── Guard anti-concurrence ────────────────────────────────────
let tickRunning = false;
let lastFullScan = 0;

// ── Utilitaires ───────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCooldownMs(msg) {
    const timeMatch = msg.match(/(\d{2}):(\d{2}):(\d{2})/);
    if (timeMatch) {
        const now = new Date();
        const target = new Date();
        target.setHours(+timeMatch[1], +timeMatch[2], +timeMatch[3], 0);
        if (target <= now) target.setDate(target.getDate() + 1);
        return Math.max(500, target - now) + 500;
    }
    const secMatch = msg.match(/(\d+(?:[.,]\d+)?)\s*s/i);
    if (secMatch) return Math.ceil(parseFloat(secMatch[1].replace(',', '.'))) * 1000 + 1000;
    return null;
}

function isCooldownError(msg) {
    return /cooldown|disponible|attendre|wait|trop t.t|prochaine/i.test(msg);
}

function isCellOccupiedError(msg) {
    return /occup/i.test(msg);
}

async function doActionWithCooldown(teamId, shipId, action, x, y) {
    try {
        return await doAction(teamId, shipId, action, x, y);
    } catch (e) {
        if (isCooldownError(e.message)) {
            const wait = parseCooldownMs(e.message) ?? 6_000;
            log(shipId, `Cooldown détecté (${action}), attente ${wait}ms`);
            await sleep(wait);
            return await doAction(teamId, shipId, action, x, y);
        }
        throw e;
    }
}

function chebyshevDist(x1, y1, x2, y2) {
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

function isAdjacent(x1, y1, x2, y2) {
    return chebyshevDist(x1, y1, x2, y2) === 1;
}

function findNextStep(sx, sy, tx, ty, avoidEnemies = true, avoidReserved = true) {
    if (isAdjacent(sx, sy, tx, ty)) return null;

    const startKey = `${sx}_${sy}`;
    const parent = new Map([[startKey, null]]);
    const queue = [{ x: sx, y: sy }];

    while (queue.length > 0) {
        const { x, y } = queue.shift();

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
                const nkey = `${nx}_${ny}`;
                if (parent.has(nkey)) continue;
                if (planetCache.has(nkey) && !(nx === tx && ny === ty)) continue;
                if (avoidEnemies && enemyCache.has(nkey)) continue;
                if (avoidReserved && reservedCells.has(nkey)) continue;

                parent.set(nkey, `${x}_${y}`);

                if (isAdjacent(nx, ny, tx, ty)) {
                    let cur = nkey;
                    while (parent.get(cur) !== startKey) cur = parent.get(cur);
                    const [fx, fy] = cur.split('_').map(Number);
                    return { x: fx, y: fy };
                }

                queue.push({ x: nx, y: ny });
            }
        }
    }
    if (avoidEnemies) return findNextStep(sx, sy, tx, ty, false, avoidReserved);
    if (avoidReserved) return findNextStep(sx, sy, tx, ty, false, false);
    return null;
}

function extractOwnerId(proprietaire) {
    if (!proprietaire) return null;
    if (typeof proprietaire === "string") return proprietaire;
    return proprietaire.idEquipe || null;
}

function log(name, msg) {
    const t = new Date().toLocaleTimeString("fr-FR");
    console.log(`[Bot ${t}][${name}] ${msg}`);
}

// ── Cache update ──────────────────────────────────────────────
function updateCache(cells) {
    const now = Date.now();
    for (const [key, e] of enemyCache) {
        if (now - e.lastSeen > ENEMY_STALE_MS) enemyCache.delete(key);
    }

    for (const cell of cells) {
        if (cell.vaisseau) {
            const ownerId = extractOwnerId(cell.vaisseau.proprietaire);
            if (ownerId && ownerId !== state.teamId) {
                const ekey = `${cell.coord_x}_${cell.coord_y}`;
                enemyCache.set(ekey, { x: cell.coord_x, y: cell.coord_y, teamId: ownerId, lastSeen: now });
            } else if (ownerId === state.teamId) {
                enemyCache.delete(`${cell.coord_x}_${cell.coord_y}`);
            }
        }

        if (!cell.planete) continue;
        const type = cell.planete.modelePlanete?.typePlanete;
        if (!type || type === 'VIDE') continue;

        const key = `${cell.coord_x}_${cell.coord_y}`;
        const hp = cell.planete.pointDeVie ?? 0;
        const ownerId = extractOwnerId(cell.proprietaire);
        const existing = planetCache.get(key);
        if (existing) {
            existing.hp = hp;
            existing.ownerId = ownerId;
            existing.lastSeen = Date.now();
        } else {
            planetCache.set(key, {
                x: cell.coord_x,
                y: cell.coord_y,
                hp,
                ownerId,
                immune: false,
                stuckCount: 0,
                lastSeen: Date.now(),
            });
        }
    }
}

async function scanArea(x1, y1, x2, y2) {
    try {
        const cells = await getMap(
            Math.max(0, x1), Math.min(MAP_SIZE - 1, x2),
            Math.max(0, y1), Math.min(MAP_SIZE - 1, y2),
        );
        if (cells) updateCache(cells);
    } catch (e) {
        console.error("[Bot] scan error:", e);
    }
}

async function scanAroundShip(x, y, radius = 12) {
    await scanArea(x - radius, y - radius, x + radius, y + radius);
}

async function fullScan() {
    const now = Date.now();
    if (now - lastFullScan < FULL_SCAN_COOLDOWN_MS) return;
    lastFullScan = now;
    log("BOT", "Scan complet de la carte...");
    for (let x = 0; x < MAP_SIZE; x += CHUNK) {
        for (let y = 0; y < MAP_SIZE; y += CHUNK) {
            await scanArea(x, y, x + CHUNK - 1, y + CHUNK - 1);
            await sleep(200);
        }
    }
    log("BOT", `Cache : ${planetCache.size} planètes, ${skippedPlanets.size} ignorées`);
    notify(`[Bot] ${planetCache.size} planètes connues`, "info");
}

// ── Sélection de cible ────────────────────────────────────────
function getBestTarget(shipX, shipY, myShipId) {
    const myId = state.teamId;
    let best = null;
    let bestScore = Infinity;

    for (const [key, planet] of planetCache) {
        if (skippedPlanets.has(key)) continue;
        if (planet.ownerId === myId) continue;
        if (planet.x === shipX && planet.y === shipY) continue;
        if (planet.immune) continue;
        if ((planet.stuckCount ?? 0) >= STUCK_THRESHOLD) {
            skippedPlanets.add(key);
            continue;
        }

        const claimer = claimedTargets.get(key);
        if (claimer && claimer !== myShipId) continue;

        const d = chebyshevDist(shipX, shipY, planet.x, planet.y);
        let enemyRisk = 0;
        for (const enemy of enemyCache.values()) {
            if (chebyshevDist(enemy.x, enemy.y, planet.x, planet.y) <= ENEMY_RISK_RADIUS) {
                enemyRisk += ENEMY_RISK_PENALTY;
                break;
            }
        }
        const score = planet.hp + d * DIST_WEIGHT + enemyRisk;
        if (score < bestScore) {
            bestScore = score;
            best = { key, ...planet };
        }
    }
    return best;
}

function releaseClaim(shipId, key) {
    if (claimedTargets.get(key) === shipId) claimedTargets.delete(key);
}

function abandonTarget(id, ss, skip = false) {
    if (ss.target) {
        if (skip) skippedPlanets.add(ss.target.key);
        releaseClaim(id, ss.target.key);
    }
    ss.target = null;
    ss.phase = Phase.SEARCH;
    ss.hpBeforeAttack = null;
}

// ── Tick par vaisseau ─────────────────────────────────────────
async function tickShip(ship) {
    const id = ship.idVaisseau;
    const sx = ship.positionX;
    const sy = ship.positionY;

    if (sx === undefined || sy === undefined) {
        log(ship.nom, "ERREUR: position inconnue");
        return;
    }

    if (!shipState.has(id)) {
        shipState.set(id, { phase: Phase.SEARCH, target: null, lastAttackTime: null, hpBeforeAttack: null });
    }
    const ss = shipState.get(id);

    log(ship.nom, `[phase=${ss.phase}] pos=(${sx},${sy}) cible=${ss.target?.key ?? "—"}`);

    if (ss.target) {
        const cached = planetCache.get(ss.target.key);
        if (cached) {
            ss.target.hp = cached.hp;
            ss.target.ownerId = cached.ownerId;
        }
        if (ss.target.ownerId === state.teamId) {
            log(ship.nom, `${ss.target.key} conquise, nouvelle cible`);
            abandonTarget(id, ss);
        }
    }

    switch (ss.phase) {

        case Phase.SEARCH: {
            await scanAroundShip(sx, sy);
            let target = getBestTarget(sx, sy, id);
            if (!target) {
                await fullScan();
                target = getBestTarget(sx, sy, id);
            }
            if (!target) {
                log(ship.nom, "Aucune cible disponible.");
                return;
            }
            ss.target = { ...target };
            ss.hpBeforeAttack = null;
            claimedTargets.set(target.key, id);
            log(ship.nom, `Cible choisie : (${target.x},${target.y}) HP=${target.hp}`);
            if (target.hp <= 0) {
                ss.phase = isAdjacent(sx, sy, target.x, target.y) ? Phase.CONQUER : Phase.MOVE;
                ss.lastAttackTime = null;
            } else {
                ss.phase = isAdjacent(sx, sy, target.x, target.y) ? Phase.ATTACK : Phase.MOVE;
            }
            break;
        }

        case Phase.MOVE: {
            if (!ss.target) { ss.phase = Phase.SEARCH; return; }
            if (isAdjacent(sx, sy, ss.target.x, ss.target.y)) {
                ss.phase = ss.target.hp <= 0 ? (ss.lastAttackTime ? Phase.WAIT_CONQUER : Phase.CONQUER) : Phase.ATTACK;
                log(ship.nom, `Adjacent à cible, phase → ${ss.phase}`);
                return;
            }
            const step = findNextStep(sx, sy, ss.target.x, ss.target.y);
            if (!step) {
                log(ship.nom, `Aucun chemin vers (${ss.target.x},${ss.target.y}), abandon`);
                abandonTarget(id, ss, true);
                return;
            }

            const stepKey = `${step.x}_${step.y}`;
            await scanArea(step.x, step.y, step.x, step.y);

            const blockedByEnemy = enemyCache.has(stepKey);
            const blockedByAlly  = reservedCells.has(stepKey);
            if (blockedByEnemy || blockedByAlly) {
                log(ship.nom, `Case (${step.x},${step.y}) occupée, replanification`);
                return;
            }

            reservedCells.add(stepKey);

            log(ship.nom, `MOVE : (${sx},${sy}) → (${step.x},${step.y}) [cible (${ss.target.x},${ss.target.y})]`);
            try {
                await doActionWithCooldown(state.teamId, id, "DEPLACEMENT", step.x, step.y);
                log(ship.nom, `✓ Déplacement vers (${step.x},${step.y})`);
            } catch (e) {
                reservedCells.delete(stepKey);
                if (isCellOccupiedError(e.message)) {
                    enemyCache.set(stepKey, { x: step.x, y: step.y, teamId: "unknown", lastSeen: Date.now() });
                    log(ship.nom, `Case bloquée, replanification au prochain tick`);
                } else {
                    log(ship.nom, `✗ Erreur déplacement : ${e.message}`);
                }
            }
            break;
        }

        case Phase.ATTACK: {
            if (!ss.target) { ss.phase = Phase.SEARCH; return; }
            if (ss.target.hp <= 0) { ss.phase = Phase.WAIT_CONQUER; return; }
            if (!isAdjacent(sx, sy, ss.target.x, ss.target.y)) {
                ss.phase = Phase.MOVE;
                return;
            }

            const cached = planetCache.get(ss.target.key);
            if (ss.hpBeforeAttack !== null && ss.target.hp >= ss.hpBeforeAttack) {
                if (cached) cached.stuckCount = (cached.stuckCount || 0) + 1;
                if ((cached?.stuckCount ?? 0) >= STUCK_THRESHOLD) {
                    log(ship.nom, `Planète ${ss.target.key} immunisée, mise en cache.`);
                    if (cached) cached.immune = true;
                    abandonTarget(id, ss, true);
                    return;
                }
            } else if (ss.hpBeforeAttack !== null && cached) {
                cached.stuckCount = 0;
            }

            ss.hpBeforeAttack = ss.target.hp;
            log(ship.nom, `⚔ Attaque (${ss.target.x},${ss.target.y}) HP=${ss.hpBeforeAttack}`);
            try {
                await doActionWithCooldown(state.teamId, id, "ATTAQUER", ss.target.x, ss.target.y);
                ss.lastAttackTime = Date.now();
                await sleep(500);
                await scanArea(ss.target.x - 1, ss.target.y - 1, ss.target.x + 1, ss.target.y + 1);
                const updated = planetCache.get(ss.target.key);
                if (updated) {
                    ss.target.hp = updated.hp;
                    log(ship.nom, `HP après attaque : ${updated.hp}`);
                    if (updated.hp <= 0) ss.phase = Phase.WAIT_CONQUER;
                }
            } catch (e) {
                log(ship.nom, `✗ Erreur attaque : ${e.message}`);
            }
            break;
        }

        case Phase.WAIT_CONQUER: {
            if (!ss.target) { ss.phase = Phase.SEARCH; return; }
            if (ship.dateProchaineAction) {
                const ready = new Date(ship.dateProchaineAction) <= new Date();
                if (!ready) {
                    const rem = Math.ceil((new Date(ship.dateProchaineAction) - Date.now()) / 1000);
                    log(ship.nom, `⏳ Conquête dans ${Math.floor(rem / 60)}m${rem % 60}s`);
                    return;
                }
            }
            ss.phase = Phase.CONQUER;
            break;
        }

        case Phase.CONQUER: {
            if (!ss.target) { ss.phase = Phase.SEARCH; return; }
            if (!isAdjacent(sx, sy, ss.target.x, ss.target.y)) {
                ss.phase = Phase.MOVE;
                return;
            }
            log(ship.nom, `★ Conquête de (${ss.target.x},${ss.target.y})`);
            try {
                await doActionWithCooldown(state.teamId, id, "CONQUERIR", ss.target.x, ss.target.y);
            } catch (e) {
                log(ship.nom, `Erreur conquête (${e.message}), vérification...`);
            }
            await sleep(500);
            await scanArea(ss.target.x - 1, ss.target.y - 1, ss.target.x + 1, ss.target.y + 1);
            const cached = planetCache.get(ss.target.key);
            if (cached?.ownerId === state.teamId) {
                log(ship.nom, `✓ Planète conquise !`);
                notify(`[Bot] ${ship.nom} a conquis une planète !`, "success");
                abandonTarget(id, ss);
            } else {
                log(ship.nom, `✗ Conquête échouée (proprio=${cached?.ownerId ?? "null"}), retour en ATTACK`);
                ss.phase = Phase.ATTACK;
                ss.hpBeforeAttack = null;
            }
            break;
        }
    }
}

// ── Boucle principale ─────────────────────────────────────────
let botActive   = false;
let botInterval = null;

async function botTick() {
    if (!botActive || tickRunning) return;
    tickRunning = true;
    reservedCells.clear();
    try {
        const ships = await getShips(state.teamId);
        if (!ships?.length) { log("BOT", "Aucun vaisseau"); return; }

        const activeShips = ships.filter(s =>
            (s.pointDeVie ?? 1) > 0 && getRole(s.idVaisseau) === Role.ATTACK
        );
        if (!activeShips.length) return;
        log("BOT", `${activeShips.length} vaisseau(x) en ATTACK`);

        for (const ship of activeShips) {
            await tickShip(ship);
            await sleep(500);
        }
    } catch (e) {
        log("BOT", `Erreur tick : ${e.message}`);
        console.error("[Bot] Erreur tick :", e);
    } finally {
        tickRunning = false;
    }
}

export async function startBot() {
    if (botActive) { notify("[Bot] Déjà actif", "info"); return; }
    botActive = true;
    lastFullScan = 0;
    notify("[Bot] Démarrage — scan initial...", "info");
    await fullScan();
    botInterval = setInterval(botTick, TICK_MS);
    log("BOT", "Actif");
    notify("[Bot] Actif ✓", "info");
}

export function stopBot() {
    botActive = false;
    clearInterval(botInterval);
    botInterval = null;
    tickRunning = false;
    claimedTargets.clear();
    shipState.clear();
    skippedPlanets.clear();
    reservedCells.clear();
    log("BOT", "Arrêté");
    notify("[Bot] Arrêté", "info");
}

export function isBotActive() { return botActive; }