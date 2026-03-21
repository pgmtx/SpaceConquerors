// Bot minier — génère des crédits via le cycle RECOLTER → DEPOSER
// Flux : trouver planète ressource → RECOLTER → aller dépôt → DEPOSER (→ crédits)

import { doAction, getShips, getMap, getTeam } from "./api.js";
import { state } from "./state.js";
import { notify } from "./ui.js";

// ── Constantes ────────────────────────────────────────────────
const TICK_MS  = 3_000;
const MAP_SIZE = 58;
const CHUNK    = 18;

const MinePhase = Object.freeze({
    FIND_DEPOT:        "FIND_DEPOT",
    FIND_RESOURCE:     "FIND_RESOURCE",
    MOVE_TO_RESOURCE:  "MOVE_TO_RESOURCE",
    HARVEST:           "HARVEST",
    MOVE_TO_DEPOT:     "MOVE_TO_DEPOT",
    DEPOSIT:           "DEPOSIT",
});

// ── État global ───────────────────────────────────────────────
// Notre planète avec module DECHARGEMENT_RESSOURCE
let depotPos = null; // { x, y }

// Planètes connues (obstacles BFS) : key "x_y" → { x, y }
const allPlanets = new Map();
// Planètes avec minerai : key "x_y" → { x, y }
const resourcePlanets = new Map();
// Cases déclarées inaccessibles par le serveur → obstacles temporaires BFS
const inaccessibleCells = new Set();

// État par vaisseau : shipId → { phase, target }
const mineState = new Map();

// ── Guard anti-concurrence ────────────────────────────────────
let mineActive   = false;
let mineInterval = null;
let tickRunning  = false;

// ── Utilitaires ───────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(name, msg) {
    const t = new Date().toLocaleTimeString("fr-FR");
    console.log(`[Mine ${t}][${name}] ${msg}`);
}

function chebyshevDist(x1, y1, x2, y2) {
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

function isAdjacent(x1, y1, x2, y2) {
    return chebyshevDist(x1, y1, x2, y2) === 1;
}

// BFS : premier pas vers (tx,ty), évite planètes et cases inaccessibles connues
function findNextStep(sx, sy, tx, ty) {
    if (isAdjacent(sx, sy, tx, ty)) return null;
    const startKey = `${sx}_${sy}`;
    const parent   = new Map([[startKey, null]]);
    const queue    = [{ x: sx, y: sy }];

    while (queue.length > 0) {
        const { x, y } = queue.shift();
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
                const nkey = `${nx}_${ny}`;
                if (parent.has(nkey)) continue;
                // Évite les planètes (sauf la cible) et les cases inaccessibles
                if (allPlanets.has(nkey) && !(nx === tx && ny === ty)) continue;
                if (inaccessibleCells.has(nkey)) continue;
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
    return null;
}

// ── Gestion erreurs ───────────────────────────────────────────
function parseCooldownMs(msg) {
    const timeMatch = msg.match(/(\d{2}):(\d{2}):(\d{2})/);
    if (timeMatch) {
        const now = new Date(), target = new Date();
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

// "Case cible inaccessible (obstacle ou case vide)"
function isInaccessibleError(msg) {
    return /inaccessible|case vide|obstacle/i.test(msg);
}

async function doActionWithCooldown(teamId, shipId, action, x, y) {
    try {
        return await doAction(teamId, shipId, action, x, y);
    } catch (e) {
        if (isCooldownError(e.message)) {
            const wait = parseCooldownMs(e.message) ?? 6_000;
            log(shipId, `Cooldown (${action}), attente ${wait}ms`);
            await sleep(wait);
            return await doAction(teamId, shipId, action, x, y);
        }
        throw e;
    }
}

// ── Scan carte ────────────────────────────────────────────────
function updateFromCells(cells) {
    for (const cell of cells) {
        if (!cell.planete) continue;
        const type = cell.planete.modelePlanete?.typePlanete;
        if (!type || type === 'VIDE') continue;

        const key = `${cell.coord_x}_${cell.coord_y}`;
        allPlanets.set(key, { x: cell.coord_x, y: cell.coord_y });

        // On ne peut voir/miner que nos planètes ou les planètes neutres (sans proprio)
        // Les planètes ennemies ne retournent pas mineraiDisponible
        const ownerId = cell.proprietaire?.idEquipe ?? null;
        const isOurs    = ownerId === state.teamId;
        const isNeutral = ownerId === null;
        if (!isOurs && !isNeutral) continue;

        // Spec: mineraiDisponible = quantité de minerai sur la planète
        const minerai = cell.planete.mineraiDisponible ?? 0;
        if (minerai > 0) {
            resourcePlanets.set(key, { x: cell.coord_x, y: cell.coord_y });
        } else {
            resourcePlanets.delete(key);
        }
    }
}

async function scanArea(x1, y1, x2, y2) {
    try {
        const cells = await getMap(
            Math.max(0, x1), Math.min(MAP_SIZE - 1, x2),
            Math.max(0, y1), Math.min(MAP_SIZE - 1, y2),
        );
        if (cells) updateFromCells(cells);
    } catch (e) {
        console.error("[Mine] scan error:", e);
    }
}

// ── Découverte du dépôt ───────────────────────────────────────
// Cherche notre planète avec module DECHARGEMENT_RESSOURCE (toujours sur la planète de départ).
async function refreshDepot() {
    try {
        const team = await getTeam(state.teamId);
        // Spec: Equipe.planetes → array de Planete avec leurs modules posés
        const planets = team.planetes ?? [];

        for (const p of planets) {
            const modules = p.modules ?? [];
            const hasUnload = modules.some(
                m => m.paramModule?.typeModule === 'DECHARGEMENT_RESSOURCE'
            );
            if (hasUnload) {
                const x = p.coord_x;
                const y = p.coord_y;
                if (x !== undefined && y !== undefined) {
                    depotPos = { x, y };
                    allPlanets.set(`${x}_${y}`, { x, y }); // obstacle BFS
                    log("DEPOT", `Dépôt (DECHARGEMENT_RESSOURCE) : (${x},${y})`);
                    return;
                }
            }
        }

        // Fallback : première planète connue
        if (planets.length > 0) {
            const p = planets[0];
            const x = p.coord_x;
            const y = p.coord_y;
            if (x !== undefined && y !== undefined) {
                depotPos = { x, y };
                allPlanets.set(`${x}_${y}`, { x, y });
                log("DEPOT", `Dépôt (fallback 1ère planète) : (${x},${y})`);
                return;
            }
        }

        log("DEPOT", `Impossible de trouver le dépôt. Planètes: ${JSON.stringify(planets).slice(0, 200)}`);
    } catch (e) {
        log("DEPOT", `Erreur : ${e.message}`);
    }
}

// ── Cargo ─────────────────────────────────────────────────────
// Spec: Vaisseau.mineraiTransporte = minerai transporté par le vaisseau
function getMineraiTransporte(ship) {
    return ship.mineraiTransporte ?? 0;
}

function getCapaciteMax(ship) {
    return ship.type?.capaciteTransport ?? Infinity;
}

function isCargoFull(ship) {
    return getMineraiTransporte(ship) >= getCapaciteMax(ship);
}

function hasCargoToDeposit(ship) {
    return getMineraiTransporte(ship) > 0;
}

// ── Sélection planète ressource ───────────────────────────────
function getNearestResource(sx, sy) {
    let best = null, bestDist = Infinity;
    for (const [key, rp] of resourcePlanets) {
        if (depotPos && rp.x === depotPos.x && rp.y === depotPos.y) continue;
        const d = chebyshevDist(sx, sy, rp.x, rp.y);
        if (d < bestDist) { bestDist = d; best = { key, ...rp }; }
    }
    return best;
}

// ── Tick par vaisseau ─────────────────────────────────────────
async function tickMineShip(ship) {
    const id = ship.idVaisseau;
    const sx = ship.positionX;
    const sy = ship.positionY;
    if (sx === undefined || sy === undefined) return;

    if (!mineState.has(id)) {
        const initPhase = hasCargoToDeposit(ship)
            ? MinePhase.MOVE_TO_DEPOT
            : MinePhase.FIND_DEPOT;
        mineState.set(id, { phase: initPhase, target: null });
    }
    const ms = mineState.get(id);

    const cargo = getMineraiTransporte(ship);
    const cap   = getCapaciteMax(ship);
    log(ship.nom, `[${ms.phase}] pos=(${sx},${sy}) cargo=${cargo}/${cap} cible=${ms.target?.key ?? "—"}`);

    switch (ms.phase) {

        case MinePhase.FIND_DEPOT: {
            if (!depotPos) await refreshDepot();
            if (!depotPos) { log(ship.nom, "Pas de dépôt disponible"); return; }
            ms.phase = MinePhase.FIND_RESOURCE;
            break;
        }

        case MinePhase.FIND_RESOURCE: {
            // Si cargo plein, aller déposer directement
            if (isCargoFull(ship)) { ms.phase = MinePhase.MOVE_TO_DEPOT; return; }

            await scanArea(sx - 12, sy - 12, sx + 12, sy + 12);
            let rp = getNearestResource(sx, sy);

            if (!rp) {
                log(ship.nom, "Scan complet...");
                for (let cx = 0; cx < MAP_SIZE; cx += CHUNK) {
                    for (let cy = 0; cy < MAP_SIZE; cy += CHUNK) {
                        await scanArea(cx, cy, cx + CHUNK - 1, cy + CHUNK - 1);
                        await sleep(150);
                    }
                }
                rp = getNearestResource(sx, sy);
            }

            if (!rp) { log(ship.nom, "Aucune planète avec minerai trouvée"); return; }
            ms.target = rp;
            ms.phase = isAdjacent(sx, sy, rp.x, rp.y)
                ? MinePhase.HARVEST
                : MinePhase.MOVE_TO_RESOURCE;
            log(ship.nom, `Cible minerai : (${rp.x},${rp.y})`);
            break;
        }

        case MinePhase.MOVE_TO_RESOURCE: {
            if (!ms.target) { ms.phase = MinePhase.FIND_RESOURCE; return; }
            if (isAdjacent(sx, sy, ms.target.x, ms.target.y)) {
                ms.phase = MinePhase.HARVEST; return;
            }
            // Rescanner le prochain pas pour avoir les obstacles à jour
            const step = findNextStep(sx, sy, ms.target.x, ms.target.y);
            if (!step) {
                log(ship.nom, `Aucun chemin vers (${ms.target.x},${ms.target.y}), abandon`);
                ms.target = null;
                ms.phase = MinePhase.FIND_RESOURCE;
                return;
            }
            const stepKey = `${step.x}_${step.y}`;
            try {
                await doActionWithCooldown(state.teamId, id, "DEPLACEMENT", step.x, step.y);
                log(ship.nom, `→ (${step.x},${step.y})`);
            } catch (e) {
                if (isInaccessibleError(e.message)) {
                    // Marquer la case comme obstacle pour le BFS
                    inaccessibleCells.add(stepKey);
                    log(ship.nom, `Case (${step.x},${step.y}) inaccessible, ajoutée aux obstacles`);
                } else {
                    log(ship.nom, `Erreur déplacement : ${e.message}`);
                }
            }
            break;
        }

        case MinePhase.HARVEST: {
            if (!ms.target) { ms.phase = MinePhase.FIND_RESOURCE; return; }
            if (!isAdjacent(sx, sy, ms.target.x, ms.target.y)) {
                ms.phase = MinePhase.MOVE_TO_RESOURCE; return;
            }
            log(ship.nom, `⛏ RECOLTER sur (${ms.target.x},${ms.target.y})`);
            try {
                const resp = await doActionWithCooldown(state.teamId, id, "RECOLTER", ms.target.x, ms.target.y);
                const qty = resp?.ressource ?? "?";
                log(ship.nom, `✓ Récolté ${qty} minerai`);
                // Si cargo plein ou planète épuisée, aller déposer
                ms.phase = depotPos ? MinePhase.MOVE_TO_DEPOT : MinePhase.FIND_DEPOT;
            } catch (e) {
                log(ship.nom, `✗ RECOLTER échoué : ${e.message}`);
                // Planète épuisée ou action impossible → retirer de la liste et chercher ailleurs
                resourcePlanets.delete(ms.target.key);
                ms.target = null;
                ms.phase = MinePhase.FIND_RESOURCE;
            }
            break;
        }

        case MinePhase.MOVE_TO_DEPOT: {
            if (!depotPos) { ms.phase = MinePhase.FIND_DEPOT; return; }
            if (isAdjacent(sx, sy, depotPos.x, depotPos.y)) {
                ms.phase = MinePhase.DEPOSIT; return;
            }
            const step = findNextStep(sx, sy, depotPos.x, depotPos.y);
            if (!step) { log(ship.nom, "Aucun chemin vers le dépôt"); return; }
            const stepKey = `${step.x}_${step.y}`;
            try {
                await doActionWithCooldown(state.teamId, id, "DEPLACEMENT", step.x, step.y);
                log(ship.nom, `→ dépôt (${step.x},${step.y})`);
            } catch (e) {
                if (isInaccessibleError(e.message)) {
                    inaccessibleCells.add(stepKey);
                    log(ship.nom, `Case (${step.x},${step.y}) inaccessible, ajoutée aux obstacles`);
                } else {
                    log(ship.nom, `Erreur déplacement vers dépôt : ${e.message}`);
                }
            }
            break;
        }

        case MinePhase.DEPOSIT: {
            if (!depotPos) { ms.phase = MinePhase.FIND_DEPOT; return; }
            if (!isAdjacent(sx, sy, depotPos.x, depotPos.y)) {
                ms.phase = MinePhase.MOVE_TO_DEPOT; return;
            }
            log(ship.nom, `💰 DEPOSER sur (${depotPos.x},${depotPos.y})`);
            try {
                await doActionWithCooldown(state.teamId, id, "DEPOSER", depotPos.x, depotPos.y);
                log(ship.nom, "✓ Dépôt effectué → crédits générés !");
                notify(`[Mine] ${ship.nom} a déposé du minerai → crédits !`, "success");
                ms.target = null;
                ms.phase = MinePhase.FIND_RESOURCE;
            } catch (e) {
                log(ship.nom, `✗ DEPOSER échoué : ${e.message}`);
                // Le dépôt est peut-être incorrect → recalculer
                depotPos = null;
                ms.phase = MinePhase.FIND_DEPOT;
            }
            break;
        }
    }
}

// ── Boucle principale ─────────────────────────────────────────
async function mineTick() {
    if (!mineActive || tickRunning) return;
    tickRunning = true;
    try {
        const ships = await getShips(state.teamId);
        if (!ships?.length) { log("BOT", "Aucun vaisseau"); return; }
        const alive = ships.filter(s => (s.pointDeVie ?? 1) > 0);
        log("BOT", `${alive.length} vaisseau(x) actif(s)`);
        for (const ship of alive) {
            await tickMineShip(ship);
            await sleep(500);
        }
    } catch (e) {
        log("BOT", `Erreur tick : ${e.message}`);
        console.error("[Mine] Erreur tick :", e);
    } finally {
        tickRunning = false;
    }
}

// ── API publique ──────────────────────────────────────────────
export async function startMiningBot() {
    if (mineActive) { notify("[Mine] Déjà actif", "info"); return; }
    mineActive = true;
    notify("[Mine] Démarrage — recherche dépôt...", "info");
    await refreshDepot();
    mineInterval = setInterval(mineTick, TICK_MS);
    log("BOT", "Bot minier actif");
    notify("[Mine] Actif ✓", "info");
}

export function stopMiningBot() {
    mineActive = false;
    clearInterval(mineInterval);
    mineInterval = null;
    tickRunning = false;
    mineState.clear();
    inaccessibleCells.clear();
    log("BOT", "Bot minier arrêté");
    notify("[Mine] Arrêté", "info");
}

export function isMiningBotActive() { return mineActive; }
