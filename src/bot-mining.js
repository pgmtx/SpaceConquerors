// Bot minier — trouver planète proche → RECOLTER → DEPOSER sur planète avec module déchargement
// Si aucune planète disponible, passe en mode ATTACK.

import { doAction, getShips, getMap, getTeam } from "./api.js";
import { state } from "./state.js";
import { notify } from "./ui.js";
import { getRole, setRole, Role } from "./assignments.js";

const TICK_MS  = 3_000;
const MAP_SIZE = 58;

let mineActive   = false;
let mineInterval = null;
let tickRunning  = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(name, msg) {
    console.log(`[Mine ${new Date().toLocaleTimeString("fr-FR")}][${name}] ${msg}`);
}

function chebyshev(x1, y1, x2, y2) {
    return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
}

function isAdj(x1, y1, x2, y2) {
    return chebyshev(x1, y1, x2, y2) === 1;
}

// ── Cooldown ──────────────────────────────────────────────────
function isCooldown(msg) {
    return /cooldown|disponible|attendre|wait|trop t.t|prochaine/i.test(msg);
}
function parseCooldown(msg) {
    const t = msg.match(/(\d{2}):(\d{2}):(\d{2})/);
    if (t) {
        const now = new Date(), tgt = new Date();
        tgt.setHours(+t[1], +t[2], +t[3], 0);
        if (tgt <= now) tgt.setDate(tgt.getDate() + 1);
        return Math.max(500, tgt - now) + 500;
    }
    const s = msg.match(/(\d+(?:[.,]\d+)?)\s*s/i);
    if (s) return Math.ceil(parseFloat(s[1].replace(',', '.'))) * 1000 + 1000;
    return 6000;
}

async function act(teamId, shipId, action, x, y) {
    try {
        return await doAction(teamId, shipId, action, x, y);
    } catch (e) {
        if (isCooldown(e.message)) {
            const w = parseCooldown(e.message);
            log(shipId, `Cooldown ${action} ${w}ms`);
            await sleep(w);
            return await doAction(teamId, shipId, action, x, y);
        }
        throw e;
    }
}

// ── Scan ──────────────────────────────────────────────────────
async function scanPlanets(cx, cy, radius) {
    const x1 = Math.max(0, cx - radius), x2 = Math.min(MAP_SIZE - 1, cx + radius);
    const y1 = Math.max(0, cy - radius), y2 = Math.min(MAP_SIZE - 1, cy + radius);
    try {
        const cells = await getMap(x1, x2, y1, y2);
        if (!cells) return [];
        return cells
            .filter(c => c.planete?.identifiant)
            .map(c => ({
                key: `${c.coord_x}_${c.coord_y}`,
                x: c.coord_x, y: c.coord_y,
                ownerId: c.proprietaire?.idEquipe ?? c.proprietaire ?? null,
                minerai: c.planete.mineraiDisponible ?? null,
                identifiant: c.planete.identifiant,
            }));
    } catch (e) {
        console.error("[Mine] scan:", e.message);
        return [];
    }
}

// ── BFS ───────────────────────────────────────────────────────
function nextStep(sx, sy, tx, ty, obstacles) {
    if (isAdj(sx, sy, tx, ty)) return null;
    const start = `${sx}_${sy}`;
    const parent = new Map([[start, null]]);
    const queue = [{ x: sx, y: sy }];
    while (queue.length) {
        const { x, y } = queue.shift();
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= MAP_SIZE || ny < 0 || ny >= MAP_SIZE) continue;
            const nk = `${nx}_${ny}`;
            if (parent.has(nk)) continue;
            if (obstacles.has(nk) && !(nx === tx && ny === ty)) continue;
            parent.set(nk, `${x}_${y}`);
            if (isAdj(nx, ny, tx, ty)) {
                let cur = nk;
                while (parent.get(cur) !== start) cur = parent.get(cur);
                const [fx, fy] = cur.split('_').map(Number);
                return { x: fx, y: fy };
            }
            queue.push({ x: nx, y: ny });
        }
    }
    return null;
}

// ── Dépôt ─────────────────────────────────────────────────────
let depotPos = null;

async function findDepot() {
    try {
        const team = await getTeam(state.teamId);
        const planetes = team.planetes ?? [];
        if (!planetes.length) {
            log("DEPOT", "Aucune planète — pas de dépôt");
            return;
        }
        for (const p of planetes) {
            const hasUnload = (p.modules ?? []).some(
                m => m.paramModule?.typeModule === 'DECHARGEMENT_RESSOURCE'
            );
            if (!hasUnload) continue;
            if (p.coord_x !== undefined) {
                depotPos = { x: p.coord_x, y: p.coord_y, id: p.identifiant };
                log("DEPOT", `Trouvé (${depotPos.x},${depotPos.y})`);
                return;
            }
            if (p.identifiant) depotPos = { id: p.identifiant, x: null, y: null };
        }
        // Pas de module déchargement → utiliser n'importe quelle planète à nous
        if (!depotPos && planetes.length) {
            const p = planetes[0];
            if (p.coord_x !== undefined) {
                depotPos = { x: p.coord_x, y: p.coord_y, id: p.identifiant };
                log("DEPOT", `Pas de module déchargement, utilise (${depotPos.x},${depotPos.y})`);
            }
        }
    } catch (e) { log("DEPOT", e.message); }
}

function resolveDepot(planets) {
    if (!depotPos || depotPos.x !== null) return;
    const found = planets.find(p => p.identifiant === depotPos.id);
    if (found) {
        depotPos.x = found.x;
        depotPos.y = found.y;
        log("DEPOT", `Résolu : (${depotPos.x},${depotPos.y})`);
    }
}

// ── Tick d'un vaisseau ────────────────────────────────────────
async function tickShip(ship) {
    const id = ship.idVaisseau;
    const sx = ship.positionX, sy = ship.positionY;
    if (sx === undefined) return;

    const cargo = ship.mineraiTransporte ?? 0;
    log(ship.nom, `pos=(${sx},${sy}) cargo=${cargo}`);

    const planets = await scanPlanets(sx, sy, 9);
    resolveDepot(planets);

    const obstacles = new Set(planets.map(p => p.key));

    // Si cargo > 0 et dépôt connu → déposer
    if (cargo > 0 && depotPos !== null && depotPos.x !== null) {
        const dx = depotPos.x, dy = depotPos.y;
        if (isAdj(sx, sy, dx, dy)) {
            log(ship.nom, `💰 DEPOSER (${dx},${dy})`);
            try {
                await act(state.teamId, id, "DEPOSER", dx, dy);
                notify(`[Mine] ${ship.nom} → dépôt !`, "success");
            } catch (e) {
                log(ship.nom, `✗ DEPOSER : ${e.message}`);
                depotPos = null;
            }
        } else {
            const step = nextStep(sx, sy, dx, dy, obstacles);
            if (step) {
                await act(state.teamId, id, "DEPLACEMENT", step.x, step.y).catch(e => log(ship.nom, e.message));
            } else {
                log(ship.nom, "Pas de chemin vers dépôt");
            }
        }
        return;
    }

    // Trouver planète avec minerai
    const myId = state.teamId;
    const candidates = planets.filter(p => {
        if (depotPos?.x === p.x && depotPos?.y === p.y) return false;
        // Préférer nos planètes avec minerai, sinon planètes voisines quelconques
        if (p.ownerId === myId) return p.minerai === null || p.minerai > 0;
        return p.minerai === null || p.minerai > 0;
    });

    if (!candidates.length) {
        // Aucune planète visible → basculer en ATTACK
        log(ship.nom, "Aucune ressource → bascule ATTACK");
        setRole(id, Role.ATTACK);
        notify(`[Mine] ${ship.nom} : aucune ressource → ATTAQUE`, "info");
        return;
    }

    // Planète la plus proche
    const target = candidates.reduce((best, p) => {
        const d = chebyshev(sx, sy, p.x, p.y);
        return d < chebyshev(sx, sy, best.x, best.y) ? p : best;
    });

    if (isAdj(sx, sy, target.x, target.y)) {
        log(ship.nom, `⛏ RECOLTER (${target.x},${target.y})`);
        try {
            const r = await act(state.teamId, id, "RECOLTER", target.x, target.y);
            log(ship.nom, `✓ +${r?.ressource ?? "?"} minerai`);
        } catch (e) {
            log(ship.nom, `✗ RECOLTER : ${e.message}`);
        }
    } else {
        const step = nextStep(sx, sy, target.x, target.y, obstacles);
        if (step) {
            log(ship.nom, `→ (${step.x},${step.y}) [cible (${target.x},${target.y})]`);
            await act(state.teamId, id, "DEPLACEMENT", step.x, step.y).catch(e => log(ship.nom, e.message));
        } else {
            log(ship.nom, `Pas de chemin vers (${target.x},${target.y})`);
        }
    }
}

// ── Boucle ────────────────────────────────────────────────────
async function mineTick() {
    if (!mineActive || tickRunning) return;
    tickRunning = true;
    try {
        const ships = await getShips(state.teamId);
        const alive = (ships ?? []).filter(s =>
            (s.pointDeVie ?? 1) > 0 && getRole(s.idVaisseau) === Role.MINE
        );
        if (!alive.length) return;
        for (const ship of alive) { await tickShip(ship); await sleep(300); }
    } catch (e) {
        console.error("[Mine]", e);
    } finally {
        tickRunning = false;
    }
}

// ── API publique ──────────────────────────────────────────────
export async function startMiningBot() {
    if (mineActive) return;
    mineActive = true;
    notify("[Mine] Démarrage...", "info");
    await findDepot();
    mineInterval = setInterval(mineTick, TICK_MS);
    notify("[Mine] Actif ✓", "info");
}

export function stopMiningBot() {
    mineActive = false;
    clearInterval(mineInterval);
    mineInterval = null;
    tickRunning = false;
    depotPos = null;
    notify("[Mine] Arrêté", "info");
}

export function isMiningBotActive() { return mineActive; }