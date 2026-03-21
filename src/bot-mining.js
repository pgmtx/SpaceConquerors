// Bot minier — génère des crédits via le cycle RECOLTER → DEPOSER

import { doAction, getShips, getMap, getTeam } from "./api.js";
import { state } from "./state.js";
import { notify } from "./ui.js";
import { getRole, Role } from "./assignments.js";

// ── Constantes ────────────────────────────────────────────────
const TICK_MS  = 3_000;
const MAP_SIZE = 58;
const CHUNK    = 18;

const MinePhase = Object.freeze({
    GOTO_RESOURCE: "GOTO_RESOURCE",
    HARVEST:       "HARVEST",
    GOTO_DEPOT:    "GOTO_DEPOT",
    DEPOSIT:       "DEPOSIT",
});

// ── État global ───────────────────────────────────────────────
let depotPos = null;
const depotPlanetIds  = new Set(); // IDs planètes avec DECHARGEMENT_RESSOURCE (API équipe)
const allPlanets      = new Map(); // key "x_y" → { x, y }  (obstacles BFS)
const resourcePlanets = new Map(); // key "x_y" → { x, y }  (planètes avec minerai)
const inaccessibleCells = new Set();
const mineState       = new Map(); // shipId → { phase, target }

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

        // Matcher l'identifiant de planète avec ceux connus comme dépôt
        if (!depotPos && depotPlanetIds.has(cell.planete.identifiant)) {
            depotPos = { x: cell.coord_x, y: cell.coord_y };
            log("DEPOT", `Dépôt résolu : (${depotPos.x},${depotPos.y})`);
        }

        // Ressources : seulement nos planètes ou neutres
        const ownerId   = cell.proprietaire?.idEquipe ?? null;
        const isOurs    = ownerId === state.teamId;
        const isNeutral = ownerId === null;
        if (!isOurs && !isNeutral) continue;

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

// Récupère les IDs de planètes avec DECHARGEMENT_RESSOURCE depuis l'API équipe
async function loadDepotIds() {
    if (depotPlanetIds.size > 0) return;
    try {
        const team = await getTeam(state.teamId);
        for (const p of team.planetes ?? []) {
            const hasUnload = (p.modules ?? []).some(
                m => m.paramModule?.typeModule === 'DECHARGEMENT_RESSOURCE'
            );
            if (hasUnload && p.identifiant) {
                depotPlanetIds.add(p.identifiant);
                log("DEPOT", `ID dépôt enregistré : ${p.identifiant}`);
            }
            // Si les coords sont là directement (bonus)
            if (hasUnload && p.coord_x !== undefined && !depotPos) {
                depotPos = { x: p.coord_x, y: p.coord_y };
                log("DEPOT", `Coords directes via API : (${depotPos.x},${depotPos.y})`);
            }
        }
    } catch (e) {
        log("DEPOT", `Erreur API équipe : ${e.message}`);
    }
}

// ── Cargo ─────────────────────────────────────────────────────
function getMineraiTransporte(ship) {
    return ship.mineraiTransporte ?? 0;
}

function isCargoFull(ship) {
    const cap = ship.type?.capaciteTransport ?? Infinity;
    return getMineraiTransporte(ship) >= cap;
}

function hasCargoToDeposit(ship) {
    return getMineraiTransporte(ship) > 0;
}

// Planète la plus proche avec minerai
function getNearestResource(sx, sy) {
    let best = null, bestDist = Infinity;
    for (const [key, rp] of resourcePlanets) {
        if (depotPos && rp.x === depotPos.x && rp.y === depotPos.y) continue;
        const d = chebyshevDist(sx, sy, rp.x, rp.y);
        if (d < bestDist) { bestDist = d; best = { key, ...rp }; }
    }
    return best;
}

// ── Déplacement ───────────────────────────────────────────────
async function moveToward(ship, tx, ty) {
    const sx = ship.positionX, sy = ship.positionY;
    const step = findNextStep(sx, sy, tx, ty);
    if (!step) { log(ship.nom, `Aucun chemin vers (${tx},${ty})`); return false; }
    const stepKey = `${step.x}_${step.y}`;
    try {
        await doActionWithCooldown(state.teamId, ship.idVaisseau, "DEPLACEMENT", step.x, step.y);
        log(ship.nom, `→ (${step.x},${step.y})`);
        return true;
    } catch (e) {
        if (isInaccessibleError(e.message)) {
            inaccessibleCells.add(stepKey);
            log(ship.nom, `Case (${step.x},${step.y}) inaccessible, blacklistée`);
        } else {
            log(ship.nom, `Erreur déplacement : ${e.message}`);
        }
        return false;
    }
}

// ── Tick par vaisseau ─────────────────────────────────────────
async function tickMineShip(ship) {
    const id = ship.idVaisseau;
    const sx = ship.positionX;
    const sy = ship.positionY;
    if (sx === undefined || sy === undefined) return;

    if (!mineState.has(id)) {
        mineState.set(id, {
            phase:  hasCargoToDeposit(ship) ? MinePhase.GOTO_DEPOT : MinePhase.GOTO_RESOURCE,
            target: null,
        });
    }
    const ms = mineState.get(id);

    const cargo = getMineraiTransporte(ship);
    log(ship.nom, `[${ms.phase}] pos=(${sx},${sy}) cargo=${cargo} cible=${ms.target?.key ?? "—"}`);

    // Scanner autour du vaisseau à chaque tick (résout dépôt + ressources)
    await scanArea(sx - 9, sy - 9, sx + 9, sy + 9);

    // Charger les IDs de dépôt si pas encore fait
    if (depotPlanetIds.size === 0) await loadDepotIds();

    switch (ms.phase) {

        case MinePhase.GOTO_RESOURCE: {
            // Si cargo plein, aller déposer
            if (isCargoFull(ship) && depotPos) { ms.phase = MinePhase.GOTO_DEPOT; return; }

            // Trouver la planète la plus proche avec du minerai
            if (!ms.target || !resourcePlanets.has(ms.target.key)) {
                ms.target = getNearestResource(sx, sy);
                if (!ms.target) {
                    log(ship.nom, "Aucune planète avec minerai visible — scan étendu");
                    await scanArea(sx - 15, sy - 15, sx + 15, sy + 15);
                    ms.target = getNearestResource(sx, sy);
                }
                if (!ms.target) { log(ship.nom, "Aucune ressource trouvée"); return; }
                log(ship.nom, `Cible : (${ms.target.x},${ms.target.y})`);
            }

            if (isAdjacent(sx, sy, ms.target.x, ms.target.y)) {
                ms.phase = MinePhase.HARVEST;
            } else {
                await moveToward(ship, ms.target.x, ms.target.y);
            }
            break;
        }

        case MinePhase.HARVEST: {
            if (!ms.target) { ms.phase = MinePhase.GOTO_RESOURCE; return; }
            if (!isAdjacent(sx, sy, ms.target.x, ms.target.y)) {
                ms.phase = MinePhase.GOTO_RESOURCE; return;
            }
            log(ship.nom, `⛏ RECOLTER (${ms.target.x},${ms.target.y})`);
            try {
                const resp = await doActionWithCooldown(state.teamId, id, "RECOLTER", ms.target.x, ms.target.y);
                log(ship.nom, `✓ Récolté ${resp?.ressource ?? "?"} minerai`);
                // Après récolte : si dépôt connu → aller déposer, sinon re-récolter
                ms.target = null;
                ms.phase = depotPos ? MinePhase.GOTO_DEPOT : MinePhase.GOTO_RESOURCE;
            } catch (e) {
                log(ship.nom, `✗ RECOLTER : ${e.message}`);
                resourcePlanets.delete(ms.target.key);
                ms.target = null;
                ms.phase = MinePhase.GOTO_RESOURCE;
            }
            break;
        }

        case MinePhase.GOTO_DEPOT: {
            if (!depotPos) {
                log(ship.nom, "Dépôt inconnu, récolte d'abord");
                ms.phase = MinePhase.GOTO_RESOURCE;
                return;
            }
            if (isAdjacent(sx, sy, depotPos.x, depotPos.y)) {
                ms.phase = MinePhase.DEPOSIT;
            } else {
                await moveToward(ship, depotPos.x, depotPos.y);
            }
            break;
        }

        case MinePhase.DEPOSIT: {
            if (!depotPos || !isAdjacent(sx, sy, depotPos.x, depotPos.y)) {
                ms.phase = MinePhase.GOTO_DEPOT; return;
            }
            log(ship.nom, `💰 DEPOSER (${depotPos.x},${depotPos.y})`);
            try {
                await doActionWithCooldown(state.teamId, id, "DEPOSER", depotPos.x, depotPos.y);
                log(ship.nom, "✓ Dépôt → crédits !");
                notify(`[Mine] ${ship.nom} a déposé → crédits !`, "success");
                ms.phase = MinePhase.GOTO_RESOURCE;
            } catch (e) {
                log(ship.nom, `✗ DEPOSER : ${e.message}`);
                depotPos = null;
                depotPlanetIds.clear();
                ms.phase = MinePhase.GOTO_RESOURCE;
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
        if (!ships?.length) return;
        const alive = ships.filter(s =>
            (s.pointDeVie ?? 1) > 0 && getRole(s.idVaisseau) === Role.MINE
        );
        log("BOT", `${alive.length} vaisseau(x) minier(s) actif(s)`);
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
    notify("[Mine] Démarrage...", "info");
    // Charger les IDs de dépôt en avance (sans bloquer si ça échoue)
    await loadDepotIds();
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
    depotPlanetIds.clear();
    depotPos = null;
    log("BOT", "Bot minier arrêté");
    notify("[Mine] Arrêté", "info");
}

export function isMiningBotActive() { return mineActive; }
