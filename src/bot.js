// Bot d'automatisation des vaisseaux — mode Attaque/Conquête
// Stratégie : cibler la planète non-possédée la plus proche, attaquer, puis conquérir.
// Si un vaisseau ennemi est trop proche, s'éloigner d'abord.

import { doAction, getShips, getMap } from "./api.js";
import { state } from "./state.js";
import { notify, runAttackLoop, runNavigationLoop } from "./ui.js";
import { getRole, Role } from "./assignments.js";
import { getPlanetOwnerId, normalizeTeamId } from "./ownership.js";

// ── Constantes ────────────────────────────────────────────────
const TICK_MS               = 3_000;
const CHUNK                 = 18;
const MAP_SIZE              = 58;
const STUCK_THRESHOLD       = 3;
const FULL_SCAN_COOLDOWN_MS = 60_000;
const DANGER_RADIUS         = 4;   // Cases autour du vaisseau → fuite si ennemi dedans

const Phase = Object.freeze({
    SEARCH:       "SEARCH",
    MOVE:         "MOVE",
    ATTACK:       "ATTACK",
    WAIT_CONQUER: "WAIT_CONQUER",
    CONQUER:      "CONQUER",
    FLEE:         "FLEE",
});

// ── Cache planètes ─────────────────────────────────────────────
// Clé "x_y" → { x, y, hp, ownerId, immune, stuckCount, lastSeen }
const planetCache = new Map();
const skippedPlanets = new Set();
const claimedTargets = new Map(); // key → shipId

// ── Cache vaisseaux ennemis ────────────────────────────────────
// Clé "x_y" → { x, y, teamId, lastSeen }
const enemyCache = new Map();
const ENEMY_STALE_MS = 10_000;

// ── Cases réservées par les vaisseaux alliés ce tick ─────────
const reservedCells = new Set();

// ── État par vaisseau ─────────────────────────────────────────
// shipId → { phase, target, lastAttackTime, hpBeforeAttack }
const shipState = new Map();
const activeShipLoops = new Set();

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

function getApproachCells(tx, ty) {
    const directions = [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
    ];

    return directions
        .map(({ dx, dy }) => ({ x: tx + dx, y: ty + dy }))
        .filter(({ x, y }) => x >= 0 && x < MAP_SIZE && y >= 0 && y < MAP_SIZE)
        .filter(({ x, y }) => !planetCache.has(`${x}_${y}`));
}

function findPathToClosestApproach(sx, sy, tx, ty, avoidEnemies = true, avoidReserved = true) {
    const approachCells = getApproachCells(tx, ty);
    if (!approachCells.length) {
        return null;
    }
    const directions = [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
    ];

    const targetKeys = new Set(approachCells.map(({ x, y }) => `${x}_${y}`));
    const startKey = `${sx}_${sy}`;
    if (targetKeys.has(startKey)) {
        return [{ x: sx, y: sy }];
    }

    const parent = new Map([[startKey, null]]);
    const queue = [{ x: sx, y: sy }];

    while (queue.length > 0) {
        const { x, y } = queue.shift();

        for (const { dx, dy } of directions) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
            const nkey = `${nx}_${ny}`;
            if (parent.has(nkey)) continue;
            if (planetCache.has(nkey)) continue;
            if (avoidEnemies && enemyCache.has(nkey)) continue;
            if (avoidReserved && reservedCells.has(nkey)) continue;

            parent.set(nkey, `${x}_${y}`);

            if (targetKeys.has(nkey)) {
                const path = [];
                let cur = nkey;
                while (cur) {
                    const [px, py] = cur.split("_").map(Number);
                    path.push({ x: px, y: py });
                    cur = parent.get(cur);
                }
                return path.reverse();
            }

            queue.push({ x: nx, y: ny });
        }
    }
    if (avoidEnemies) return findPathToClosestApproach(sx, sy, tx, ty, false, avoidReserved);
    if (avoidReserved) return findPathToClosestApproach(sx, sy, tx, ty, false, false);
    return null;
}

function canReachPlanetToAttack(shipX, shipY, planet) {
    if (isAdjacent(shipX, shipY, planet.x, planet.y)) {
        return true;
    }

    return Boolean(findPathToClosestApproach(shipX, shipY, planet.x, planet.y, false, false));
}

function markPlanetAsUnattackable(target) {
    const cached = planetCache.get(target.key);
    if (!cached) {
        return;
    }

    cached.stuckCount = (cached.stuckCount || 0) + 1;
    if (cached.stuckCount >= STUCK_THRESHOLD) {
        cached.immune = true;
        skippedPlanets.add(target.key);
    }
}

function clearPlanetAttackFailures(target) {
    const cached = planetCache.get(target.key);
    if (!cached) {
        return;
    }

    cached.stuckCount = 0;
    cached.immune = false;
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
            const ownerId = normalizeTeamId(cell.vaisseau.proprietaire);
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
        const ownerId = getPlanetOwnerId(cell.planete, {
            cell,
            mapCells: cells,
            teams: state.allTeams,
            myTeam: state.myTeam
        });
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
    let best = null;
    let bestDistance = Infinity;

    for (const [key, planet] of planetCache) {
        if (skippedPlanets.has(key)) continue;
        if (planet.ownerId !== null && planet.ownerId !== undefined) continue;
        if (planet.x === shipX && planet.y === shipY) continue;
        if (planet.immune) continue;
        if ((planet.stuckCount ?? 0) >= STUCK_THRESHOLD) {
            skippedPlanets.add(key);
            continue;
        }

        const claimer = claimedTargets.get(key);
        if (claimer && claimer !== myShipId) continue;
        if (!canReachPlanetToAttack(shipX, shipY, planet)) continue;

        const distance = chebyshevDist(shipX, shipY, planet.x, planet.y);
        if (distance < bestDistance) {
            bestDistance = distance;
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

function shouldRunAutoAttack(shipId) {
    return botActive && getRole(shipId) === Role.ATTACK;
}

async function getLatestShipById(shipId) {
    const ships = await getShips(state.teamId);
    return ships?.find((ship) => ship.idVaisseau === shipId) || null;
}

async function refreshPlanetTarget(target) {
    await scanArea(target.x - 1, target.y - 1, target.x + 1, target.y + 1);
    const cached = planetCache.get(target.key);
    return cached ? { ...target, ...cached } : target;
}

async function runAutoAttackMission(ship) {
    const shipId = ship.idVaisseau;
    if (!shouldRunAutoAttack(shipId)) {
        return;
    }

    await scanAroundShip(ship.positionX, ship.positionY);
    let target = getBestTarget(ship.positionX, ship.positionY, shipId);
    if (!target) {
        await fullScan();
        target = getBestTarget(ship.positionX, ship.positionY, shipId);
    }
    if (!target) {
        log(ship.nom, "Aucune cible auto-attaque disponible.");
        return;
    }

    claimedTargets.set(target.key, shipId);

    try {
        target = await refreshPlanetTarget(target);
        if (target.ownerId === state.teamId) {
            return;
        }

        const latestBeforeMove = await getLatestShipById(shipId);
        if (!latestBeforeMove || !shouldRunAutoAttack(shipId)) {
            return;
        }

        if (!isAdjacent(latestBeforeMove.positionX, latestBeforeMove.positionY, target.x, target.y)) {
            const approachPath = findPathToClosestApproach(
                latestBeforeMove.positionX,
                latestBeforeMove.positionY,
                target.x,
                target.y
            );
            if (!approachPath || !approachPath.length) {
                skippedPlanets.add(target.key);
                log(ship.nom, `Aucun accès vers (${target.x},${target.y})`);
                return;
            }

            const destination = approachPath[approachPath.length - 1];
            log(ship.nom, `AUTO MOVE vers (${destination.x},${destination.y}) pour cible (${target.x},${target.y})`);
            const moved = await runNavigationLoop(latestBeforeMove, destination.x, destination.y, { notifyUser: false });
            if (!moved || !shouldRunAutoAttack(shipId)) {
                return;
            }
        }

        const latestBeforeAttack = await getLatestShipById(shipId);
        if (!latestBeforeAttack || !shouldRunAutoAttack(shipId)) {
            return;
        }

        target = await refreshPlanetTarget(target);
        if (target.ownerId === state.teamId) {
            return;
        }
        if (!canReachPlanetToAttack(latestBeforeAttack.positionX, latestBeforeAttack.positionY, target)) {
            markPlanetAsUnattackable(target);
            return;
        }

        if (target.hp > 0) {
            const hpBeforeAttack = target.hp;
            log(ship.nom, `AUTO ATTACK (${target.x},${target.y})`);
            const destroyed = await runAttackLoop(latestBeforeAttack, target.x, target.y, { notifyUser: false });
            if (!destroyed || !shouldRunAutoAttack(shipId)) {
                target = await refreshPlanetTarget(target);
                if ((target.hp ?? hpBeforeAttack) >= hpBeforeAttack) {
                    markPlanetAsUnattackable(target);
                }
                return;
            }
            clearPlanetAttackFailures(target);
        }

        const latestBeforeConquer = await getLatestShipById(shipId);
        if (!latestBeforeConquer || !shouldRunAutoAttack(shipId)) {
            return;
        }

        target = await refreshPlanetTarget(target);
        if (target.ownerId === state.teamId || target.hp > 0) {
            return;
        }
        if (!isAdjacent(latestBeforeConquer.positionX, latestBeforeConquer.positionY, target.x, target.y)) {
            return;
        }

        log(ship.nom, `AUTO CONQUERIR (${target.x},${target.y})`);
        await doActionWithCooldown(state.teamId, shipId, "CONQUERIR", target.x, target.y);
        target = await refreshPlanetTarget(target);
        if (target.ownerId === state.teamId) {
            notify(`[Bot] ${ship.nom} a conquis une planète !`, "success");
        }
    } finally {
        releaseClaim(shipId, target.key);
    }
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

    // ── Vérification danger ───────────────────────────────────
    // Si un ennemi est à portée DANGER_RADIUS, interrompre et fuir
    const nearbyEnemies = [...enemyCache.values()].filter(
        e => chebyshevDist(sx, sy, e.x, e.y) <= DANGER_RADIUS
    );
    if (nearbyEnemies.length > 0) {
        if (ss.phase !== Phase.FLEE) {
            log(ship.nom, `⚠ Ennemi(s) à portée, passage en FLEE`);
            ss.phase = Phase.FLEE;
        }
    } else if (ss.phase === Phase.FLEE) {
        log(ship.nom, `✓ Zone dégagée, retour en SEARCH`);
        abandonTarget(id, ss);
    }

    if (ss.target && ss.phase !== Phase.FLEE) {
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

        case Phase.FLEE: {
            // Scanner pour avoir des infos fraîches sur les ennemis
            await scanAroundShip(sx, sy, 6);

            const enemies = [...enemyCache.values()].filter(
                e => chebyshevDist(sx, sy, e.x, e.y) <= DANGER_RADIUS
            );
            if (!enemies.length) {
                log(ship.nom, `✓ Zone dégagée, retour en SEARCH`);
                abandonTarget(id, ss);
                break;
            }

            // Calcul du centroïde ennemi pour fuir dans la direction opposée
            const cx = enemies.reduce((s, e) => s + e.x, 0) / enemies.length;
            const cy = enemies.reduce((s, e) => s + e.y, 0) / enemies.length;

            // Trier les 8 cases adjacentes par distance décroissante au centroïde
            const fleeCandidates = [];
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (!dx && !dy) continue;
                    const nx = sx + dx, ny = sy + dy;
                    if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
                    if (planetCache.has(`${nx}_${ny}`)) continue;
                    if (enemyCache.has(`${nx}_${ny}`)) continue;
                    const dist = chebyshevDist(nx, ny, Math.round(cx), Math.round(cy));
                    fleeCandidates.push({ x: nx, y: ny, dist });
                }
            }
            fleeCandidates.sort((a, b) => b.dist - a.dist);

            let fled = false;
            for (const cell of fleeCandidates) {
                log(ship.nom, `🏃 FUIR vers (${cell.x},${cell.y})`);
                try {
                    await doActionWithCooldown(state.teamId, id, "DEPLACEMENT", cell.x, cell.y);
                    fled = true;
                    break;
                } catch (e) {
                    log(ship.nom, `✗ (${cell.x},${cell.y}) bloquée : ${e.message}`);
                }
            }
            if (!fled) log(ship.nom, "Aucune case de fuite disponible");
            break;
        }

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
            const path = findPathToClosestApproach(sx, sy, ss.target.x, ss.target.y);
            if (!path || path.length < 2) {
                log(ship.nom, `Aucun chemin vers (${ss.target.x},${ss.target.y}), abandon`);
                abandonTarget(id, ss, true);
                return;
            }
            const step = path[1];

            const stepKey = `${step.x}_${step.y}`;
            await scanArea(step.x, step.y, step.x, step.y);

            const blockedByEnemy = enemyCache.has(stepKey);
            const blockedByAlly  = reservedCells.has(stepKey);
            if (blockedByEnemy || blockedByAlly) {
                log(ship.nom, `Case (${step.x},${step.y}) occupée, replanification`);
                return;
            }

            reservedCells.add(stepKey);

            const destination = path[path.length - 1];
            log(ship.nom, `MOVE : (${sx},${sy}) → (${destination.x},${destination.y}) [approche cible (${ss.target.x},${ss.target.y})]`);
            try {
                const moved = await runNavigationLoop(ship, destination.x, destination.y, { notifyUser: false });
                if (!moved) {
                    reservedCells.delete(stepKey);
                    log(ship.nom, `✗ Déplacement auto interrompu vers (${destination.x},${destination.y})`);
                    return;
                }
                log(ship.nom, `✓ Déplacement auto terminé vers (${destination.x},${destination.y})`);
                ss.phase = ss.target.hp <= 0 ? Phase.CONQUER : Phase.ATTACK;
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

            log(ship.nom, `⚔ Attaque auto (${ss.target.x},${ss.target.y})`);
            try {
                const destroyed = await runAttackLoop(ship, ss.target.x, ss.target.y, { notifyUser: false });
                ss.lastAttackTime = Date.now();
                await scanArea(ss.target.x - 1, ss.target.y - 1, ss.target.x + 1, ss.target.y + 1);
                const updated = planetCache.get(ss.target.key);
                if (updated) {
                    ss.target.hp = updated.hp;
                    log(ship.nom, `HP après attaque : ${updated.hp}`);
                }
                if (destroyed || (updated && updated.hp <= 0)) ss.phase = Phase.WAIT_CONQUER;
            } catch (e) {
                log(ship.nom, `✗ Erreur attaque auto : ${e.message}`);
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
            if (activeShipLoops.has(ship.idVaisseau)) {
                continue;
            }

            activeShipLoops.add(ship.idVaisseau);
            runAutoAttackMission(ship)
                .catch((error) => {
                    log(ship.nom, `Mission auto-attaque interrompue : ${error.message}`);
                    console.error("[Bot] Mission auto-attaque :", error);
                })
                .finally(() => {
                    activeShipLoops.delete(ship.idVaisseau);
                });
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
    botTick().catch((error) => {
        log("BOT", `Erreur tick initial : ${error.message}`);
    });
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
    activeShipLoops.clear();
    skippedPlanets.clear();
    reservedCells.clear();
    log("BOT", "Arrêté");
    notify("[Bot] Arrêté", "info");
}

export function isBotActive() { return botActive; }
