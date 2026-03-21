// Bot d'automatisation des vaisseaux
// Stratégie : cibler les planètes ennemies par HP croissant, attaquer, puis conquérir

import { doAction, getShips, getMap } from "./api.js";
import { state } from "./state.js";
import { notify } from "./ui.js";

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
// Alimenté à chaque scan de carte, entrées périmées supprimées après 30s
const enemyCache = new Map();
const ENEMY_STALE_MS = 30_000;
const ENEMY_RISK_RADIUS = 3;   // Cases autour d'une cible → pénalité de risque
const ENEMY_RISK_PENALTY = 200; // Ajouté au score de cible si ennemi proche

// ── État par vaisseau ─────────────────────────────────────────
// shipId → { phase, target, lastAttackTime, hpBeforeAttack }
const shipState = new Map();

// ── Guard anti-concurrence ────────────────────────────────────
// Empêche deux ticks de tourner en même temps (fullScan > 2s)
let tickRunning = false;
let lastFullScan = 0;

// ── Utilitaires ───────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parse le temps restant depuis un message d'erreur de cooldown (en secondes)
// Ex: "Cooldown: 12.5s" ou "action disponible dans 8 secondes" etc.
function parseCooldownMs(msg) {
    const m = msg.match(/(\d+(?:[.,]\d+)?)\s*s/i);
    if (m) return Math.ceil(parseFloat(m[1].replace(',', '.'))) * 1000 + 1000;
    return null;
}

function isCooldownError(msg) {
    return /cooldown|disponible|attendre|wait|trop t.t|prochaine/i.test(msg);
}

// Effectue une action ; si l'API répond "cooldown", attend le délai indiqué + 1s puis relance une fois.
async function doActionWithCooldown(teamId, shipId, action, x, y) {
    try {
        return await doAction(teamId, shipId, action, x, y);
    } catch (e) {
        if (isCooldownError(e.message)) {
            const wait = parseCooldownMs(e.message) ?? 6_000;
            log(shipId, `Cooldown détecté (${action}), attente ${wait}ms — "${e.message}"`);
            await sleep(wait);
            return await doAction(teamId, shipId, action, x, y);
        }
        throw e;
    }
}

function chebyshevDist(x1, y1, x2, y2) {
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

// Adjacent = exactement 1 case de distance (pas la même case)
function isAdjacent(x1, y1, x2, y2) {
    return chebyshevDist(x1, y1, x2, y2) === 1;
}

// BFS : premier pas du chemin le plus court vers une case adjacente à (tx,ty)
// Évite planètes et vaisseaux ennemis (obstacles infranchissables)
function findNextStep(sx, sy, tx, ty, avoidEnemies = true) {
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
                // Planètes = obstacles sauf la cible elle-même
                if (planetCache.has(nkey) && !(nx === tx && ny === ty)) continue;
                // Vaisseaux ennemis = obstacles (évitement)
                if (avoidEnemies && enemyCache.has(nkey)) continue;

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
    // Si aucun chemin sans ennemis, réessayer sans évitement
    if (avoidEnemies) return findNextStep(sx, sy, tx, ty, false);
    return null;
}


// Extrait l'ID équipe du propriétaire (objet ou string selon le endpoint)
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
    // Purger les ennemis périmés
    for (const [key, e] of enemyCache) {
        if (now - e.lastSeen > ENEMY_STALE_MS) enemyCache.delete(key);
    }

    for (const cell of cells) {
        // Mettre à jour les vaisseaux ennemis visibles
        if (cell.vaisseau) {
            const ownerId = extractOwnerId(cell.vaisseau.proprietaire);
            if (ownerId && ownerId !== state.teamId) {
                const ekey = `${cell.coord_x}_${cell.coord_y}`;
                enemyCache.set(ekey, { x: cell.coord_x, y: cell.coord_y, teamId: ownerId, lastSeen: now });
            }
        }

        if (!cell.planete) continue;
        // Ignorer les cases vides (objet planete présent mais type VIDE ou absent)
        const type = cell.planete.modelePlanete?.typePlanete;
        if (!type || type === 'VIDE') continue;

        const key = `${cell.coord_x}_${cell.coord_y}`;
        const hp = cell.planete.pointDeVie ?? 0;
        const rawOwner = cell.planete.proprietaire ?? cell.proprietaire ?? null;
        const ownerId = extractOwnerId(rawOwner);
        const existing = planetCache.get(key);
        if (existing) {
            existing.hp = hp;
            existing.ownerId = ownerId;
            existing.lastSeen = Date.now();
            // immune reste intact une fois marquée
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
    if (now - lastFullScan < FULL_SCAN_COOLDOWN_MS) return; // Pas trop souvent
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
// Planètes dont on sait qu'elles sont invulnérables (stuckCount >= STUCK_THRESHOLD)
// → déjà dans skippedPlanets, mais on les filtre aussi ici pour être sûr

function getBestTarget(shipX, shipY, myShipId) {
    const myId = state.teamId;
    let best = null;
    let bestScore = Infinity;

    for (const [key, planet] of planetCache) {
        if (skippedPlanets.has(key)) continue;
        // Ne cibler que les planètes non possédées par nous
        if (planet.ownerId === myId) continue;
        // Impossible d'agir sur une planète à la même case que le vaisseau
        if (planet.x === shipX && planet.y === shipY) continue;
        // Ignorer les planètes immunisées (inattaquables)
        if (planet.immune) continue;
        // Ignorer les planètes déjà répertoriées comme immunisées via stuckCount
        if ((planet.stuckCount ?? 0) >= STUCK_THRESHOLD) {
            skippedPlanets.add(key);
            continue;
        }

        const claimer = claimedTargets.get(key);
        if (claimer && claimer !== myShipId) continue;

        const d = chebyshevDist(shipX, shipY, planet.x, planet.y);
        // Pénalité si un ennemi est à portée de vol (pourrait conquérir avant nous)
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

// Abandonne la cible courante et retourne en SEARCH
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
        log(ship.nom, "ERREUR: position inconnue (positionX/Y manquants)");
        return;
    }

    if (!shipState.has(id)) {
        shipState.set(id, { phase: Phase.SEARCH, target: null, lastAttackTime: null, hpBeforeAttack: null });
    }
    const ss = shipState.get(id);

    log(ship.nom, `[phase=${ss.phase}] pos=(${sx},${sy}) cible=${ss.target?.key ?? "—"}`);

    // Synchroniser cible avec cache
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
            log(ship.nom, `MOVE : (${sx},${sy}) → (${step.x},${step.y}) [cible (${ss.target.x},${ss.target.y})]`);
            try {
                await doActionWithCooldown(state.teamId, id, "DEPLACEMENT", step.x, step.y);
                log(ship.nom, `✓ Déplacement vers (${step.x},${step.y})`);
            } catch (e) {
                log(ship.nom, `✗ Erreur déplacement : ${e.message}`);
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
            // Immunité : HP inchangé après attaque → incrémenter stuckCount
            if (ss.hpBeforeAttack !== null && ss.target.hp >= ss.hpBeforeAttack) {
                if (cached) cached.stuckCount = (cached.stuckCount || 0) + 1;
                if ((cached?.stuckCount ?? 0) >= STUCK_THRESHOLD) {
                    log(ship.nom, `Planète ${ss.target.key} immunisée (HP inchangé x${STUCK_THRESHOLD}), mise en cache.`);
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
            if (!ss.lastAttackTime) { ss.phase = Phase.CONQUER; return; }
            const elapsed = Date.now() - ss.lastAttackTime;
            const conquerDelay = 3 * 60_000;
            if (elapsed >= conquerDelay) {
                ss.phase = Phase.CONQUER;
            } else {
                const rem = Math.ceil((conquerDelay - elapsed) / 1000);
                log(ship.nom, `⏳ Conquête dans ${Math.floor(rem / 60)}m${rem % 60}s`);
            }
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
                log(ship.nom, `✓ Planète conquise !`);
                notify(`[Bot] ${ship.nom} a conquis une planète !`, "success");
                const cached = planetCache.get(ss.target.key);
                if (cached) cached.ownerId = state.teamId;
                abandonTarget(id, ss);
            } catch (e) {
                log(ship.nom, `✗ Erreur conquête : ${e.message}`);
                ss.phase = Phase.ATTACK;
                ss.lastAttackTime = Date.now();
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
    try {
        const ships = await getShips(state.teamId);
        if (!ships?.length) {
            log("BOT", `Aucun vaisseau retourné par l'API`);
            return;
        }
        log("BOT", `${ships.length} vaisseau(x) trouvé(s)`);

        // Traiter uniquement les vaisseaux vivants — les détruits sont ignorés
        const activeShips = ships.filter(s => (s.pointDeVie ?? 1) > 0);

        for (const ship of activeShips) {
            await tickShip(ship);
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
    lastFullScan = 0; // Forcer le scan initial
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
    log("BOT", "Arrêté");
    notify("[Bot] Arrêté", "info");
}

export function isBotActive() { return botActive; }

export function getBotStatus() {
    const ships = [];
    for (const [id, ss] of shipState) {
        ships.push({ id, phase: ss.phase, target: ss.target?.key ?? "—" });
    }
    return { active: botActive, planets: planetCache.size, skipped: skippedPlanets.size, ships };
}
