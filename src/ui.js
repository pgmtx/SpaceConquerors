import { state } from "./state.js";
import { getTeamColor } from "./mapRenderer.js";
import { doAction } from "./api.js";

// ── Notifications ─────────────────────────────────────────────
export function notify(msg, type = "info") {
	const container = document.getElementById("notifications");
	const el = document.createElement("div");
	el.className = `notif${type !== "info" ? " " + type : ""}`;
	el.textContent = msg;
	container.appendChild(el);
	setTimeout(() => el.remove(), 3500);
}

// ── Loading progress ──────────────────────────────────────────
export function setLoading(pct, status) {
	document.getElementById("loading-bar-fill").style.width = `${pct}%`;
	if (status) document.getElementById("loading-status").textContent = status;
}

export function hideLoading() {
	const el = document.getElementById("loading");
	el.style.transition = "opacity 0.6s";
	el.style.opacity = "0";
	setTimeout(() => el.remove(), 700);
}

// ── Coordinates display ───────────────────────────────────────
export function updateCoords(x, y) {
	document.getElementById("coords-display").textContent = `[ X:${x} Y:${y} ]`;
}

// ── Resources & team stats ────────────────────────────────────
export function updateTeamHUD(team) {
	if (!team) return;

	document.getElementById("team-name").textContent =
		team.nom?.toUpperCase() || "--";

	const resources = team.ressources || [];
	const minerai =
		resources.find((r) => r.ressource?.nom === "MINERAI")?.quantite ?? 0;
	const credits =
		resources.find((r) => r.ressource?.nom === "CREDIT")?.quantite ?? 0;
	const ships =
		resources.find((r) => r.ressource?.nom === "VAISSEAU")?.quantite ?? 0;
	const points =
		resources.find((r) => r.ressource?.nom === "POINT")?.quantite ?? 0;

	document.getElementById("res-minerai").textContent = fmt(minerai);
	document.getElementById("res-credits").textContent = fmt(credits);
	document.getElementById("res-ships").textContent = fmt(ships);
	document.getElementById("team-score").textContent = `⭐ ${fmt(points)} pts`;

	// Stats bars
	const shipCount = (team.vaisseaux || []).length;
	const planetCount = (team.planetes || []).length;
	const maxShips = team.nombreSlotVaisseaux || 10;
	const maxPlanets = 20;
	const maxCredits = 10000;
	const maxMinerais = 50000;

	setStatBar("ships", shipCount, maxShips, shipCount);
	setStatBar("planets", planetCount, maxPlanets, planetCount);
	setStatBar("credits", credits, maxCredits, fmt(credits));
	setStatBar("minerai", minerai, maxMinerais, fmt(minerai));
}

function setStatBar(id, val, max, label) {
	const pct = Math.min(100, max > 0 ? (val / max) * 100 : 0);
	document.getElementById(`stat-${id}-bar`).style.width = `${pct}%`;
	document.getElementById(`stat-${id}-val`).textContent = label;
}

function fmt(n) {
	if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

// ── Leaderboard ───────────────────────────────────────────────
export function updateLeaderboard(teams) {
	const list = document.getElementById("leaderboard-list");
	list.innerHTML = "";

	// Sort by points descending
	const sorted = [...teams].sort((a, b) => {
		const pa = getPoints(a),
			pb = getPoints(b);
		return pb - pa;
	});

	sorted.slice(0, 12).forEach((team, i) => {
		const pts = getPoints(team);
		const isMe = team.idEquipe === state.teamId;
		const color =
			"#" + getTeamColor(team.idEquipe).toString(16).padStart(6, "0");

		const row = document.createElement("div");
		row.className = `lb-row${isMe ? " my-team" : ""}`;
		row.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-color" style="background:${color}"></span>
      <span class="lb-name" title="${team.nom}">${team.nom}</span>
      <span class="lb-pts">${fmt(pts)}</span>
    `;
		list.appendChild(row);
	});
}

function getPoints(team) {
	return (
		(team.ressources || []).find((r) => r.ressource?.nom === "POINT")
			?.quantite ?? 0
	);
}

// ── Info / selection panel ────────────────────────────────────
export function showShipInfo(vaisseau) {
	if (!vaisseau) return closeInfoPanel();

	document.getElementById("info-title").textContent =
		`🚀 ${vaisseau.nom} — ${vaisseau.type?.nom || vaisseau.type?.classeVaisseau || "--"}`;

	const hp = vaisseau.pointDeVie ?? "?";
	const maxHp = vaisseau.type?.pointDeVie ?? "?";
	const cargo = vaisseau.mineraiTransporte ?? 0;
	const capCargo = vaisseau.type?.capaciteTransport ?? "?";
	const pos = `(${vaisseau.positionX ?? "?"}, ${vaisseau.positionY ?? "?"})`;
	const isAvailable = isShipAvailable(vaisseau);
	const owner =
		vaisseau.proprietaire === state.teamId
			? "Vous"
			: vaisseau.proprietaire?.substring(0, 8) + "...";

	document.getElementById("info-col-1").innerHTML = `
    <div class="info-row"><span class="info-label">HP</span>
      <span class="info-value ${hp < maxHp * 0.3 ? "bad" : "good"}">${hp} / ${maxHp}</span></div>
    <div class="info-row"><span class="info-label">Position</span>
      <span class="info-value">${pos}</span></div>
    <div class="info-row"><span class="info-label">Équipe</span>
      <span class="info-value">${owner}</span></div>
  `;
	document.getElementById("info-col-2").innerHTML = `
    <div class="info-row"><span class="info-label">Attaque</span>
      <span class="info-value">${vaisseau.type?.attaque ?? "?"}</span></div>
    <div class="info-row"><span class="info-label">Cargo</span>
      <span class="info-value">${cargo} / ${capCargo}</span></div>
    <div class="info-row"><span class="info-label">Statut</span>
      <span class="info-value ${isAvailable ? "good" : "bad"}">${isAvailable ? "PRÊT" : "COOLDOWN"}</span></div>
  `;

	// Actions (only for our ships)
	const actionsPanel = document.getElementById("actions-panel");
	const actionsButtons = document.getElementById("actions-buttons");
	if (vaisseau.proprietaire === state.teamId) {
		actionsPanel.classList.add("visible");
		actionsButtons.innerHTML = "";
		const actions = [
			"DEPLACEMENT",
			"RECOLTER",
			"DEPOSER",
			"ATTAQUER",
			"CONQUERIR",
			"REPARER",
		];
		actions.forEach((action) => {
			const btn = document.createElement("button");
			btn.className = `action-btn${!isAvailable ? " cooldown" : ""}`;
			btn.textContent = action;
			btn.disabled = !isAvailable;
			btn.addEventListener("click", () => handleShipAction(vaisseau, action));
			actionsButtons.appendChild(btn);
		});
	} else {
		actionsPanel.classList.remove("visible");
	}

	openInfoPanel();
}

export function showPlanetInfo(planete) {
	if (!planete) return closeInfoPanel();

	const biome = planete.modelePlanete?.biome || "--";
	const type = planete.modelePlanete?.typePlanete || "--";
	const hp = planete.pointDeVie ?? "?";
	const minerai = planete.mineraiDisponible ?? "?";
	const slots = planete.slotsConstruction ?? "?";
	const mods = (planete.modules || []).length;

	document.getElementById("info-title").textContent = `🌍 ${planete.nom}`;

	document.getElementById("info-col-1").innerHTML = `
    <div class="info-row"><span class="info-label">Type</span><span class="info-value">${type}</span></div>
    <div class="info-row"><span class="info-label">Biome</span><span class="info-value">${biome}</span></div>
    <div class="info-row"><span class="info-label">HP</span><span class="info-value">${hp}</span></div>
  `;
	document.getElementById("info-col-2").innerHTML = `
    <div class="info-row"><span class="info-label">Minerai</span><span class="info-value">${fmt(minerai)}</span></div>
    <div class="info-row"><span class="info-label">Slots</span><span class="info-value">${slots}</span></div>
    <div class="info-row"><span class="info-label">Modules</span><span class="info-value">${mods}</span></div>
  `;
	document.getElementById("actions-panel").classList.remove("visible");
	openInfoPanel();
}

function isShipAvailable(vaisseau) {
	if (!vaisseau.dateProchaineAction) return true;
	return new Date(vaisseau.dateProchaineAction) <= new Date();
}

async function handleShipAction(vaisseau, action) {
	if (action === "DEPLACEMENT") {
		notify(
			"Clic sur la case de destination dans 3s, ou choisissez la direction",
			"info",
		);
		// The main click handler in main.js will catch the next click as a move target
		state.pendingAction = { action, vaisseau };
		return;
	}

	// For actions needing coordinates, use ship's current adjacent position
	if (
		["RECOLTER", "ATTAQUER", "CONQUERIR", "DEPOSER", "REPARER"].includes(action)
	) {
		notify(`Clic sur la cible pour ${action}`, "info");
		state.pendingAction = { action, vaisseau };
		return;
	}

	try {
		await doAction(state.teamId, vaisseau.idVaisseau, action);
		notify(`${action} effectué !`, "success");
	} catch (e) {
		notify(e.message, "error");
	}
}

export async function executePendingAction(coord_x, coord_y) {
	const pending = state.pendingAction;
	if (!pending) return false;
	state.pendingAction = null;

	try {
		await doAction(
			state.teamId,
			pending.vaisseau.idVaisseau,
			pending.action,
			coord_x,
			coord_y,
		);
		notify(`${pending.action} → (${coord_x},${coord_y}) effectué !`, "success");
	} catch (e) {
		notify(e.message, "error");
	}
	return true;
}

function openInfoPanel() {
	document.getElementById("info-panel").classList.add("visible");
}

export function closeInfoPanel() {
	document.getElementById("info-panel").classList.remove("visible");
	state.selectedShip = null;
	state.selectedPlanet = null;
	state.pendingAction = null;
}

// ── Minimap ───────────────────────────────────────────────────
let minimapCtx = null;

export function initMinimap() {
	const canvas = document.getElementById("minimap");
	minimapCtx = canvas.getContext("2d");
	canvas.addEventListener("click", onMinimapClick);
}

export function drawMinimap(cells, allTeamsData) {
	if (!minimapCtx) return;
	const canvas = minimapCtx.canvas;
	const W = canvas.width,
		H = canvas.height;
	const GRID = 58;

	minimapCtx.clearRect(0, 0, W, H);
	minimapCtx.fillStyle = "#01080f";
	minimapCtx.fillRect(0, 0, W, H);

	const cw = W / GRID,
		ch = H / GRID;

	// Draw planets from state.minimapPlanets
	state.minimapPlanets.forEach(({ x, y, ownerId, type }) => {
		const px = x * cw,
			py = y * ch;
		const color = ownerId
			? "#" + getTeamColor(ownerId).toString(16).padStart(6, "0")
			: "#334455";
		minimapCtx.fillStyle = color;
		minimapCtx.fillRect(px, py, Math.max(2, cw), Math.max(2, ch));
	});

	// Draw ships from visible cells
	cells.forEach((cell) => {
		if (!cell.vaisseau) return;
		const px = cell.coord_x * cw,
			py = cell.coord_y * ch;
		const color =
			"#" +
			getTeamColor(cell.vaisseau.proprietaire).toString(16).padStart(6, "0");
		minimapCtx.fillStyle = color;
		minimapCtx.beginPath();
		minimapCtx.arc(px + cw / 2, py + ch / 2, 2, 0, Math.PI * 2);
		minimapCtx.fill();
	});

	// Viewport indicator
	const vx = state.viewX * cw,
		vy = state.viewY * ch;
	const vw = state.viewSize * cw,
		vh = state.viewSize * ch;
	minimapCtx.strokeStyle = "rgba(0,255,204,0.8)";
	minimapCtx.lineWidth = 1;
	minimapCtx.strokeRect(vx, vy, vw, vh);
}

function onMinimapClick(e) {
	const canvas = e.target;
	const rect = canvas.getBoundingClientRect();
	const fx = (e.clientX - rect.left) / canvas.width;
	const fy = (e.clientY - rect.top) / canvas.height;
	const gx = Math.floor(fx * 58);
	const gy = Math.floor(fy * 58);
	const newX = Math.max(
		0,
		Math.min(58 - state.viewSize, gx - Math.floor(state.viewSize / 2)),
	);
	const newY = Math.max(
		0,
		Math.min(58 - state.viewSize, gy - Math.floor(state.viewSize / 2)),
	);
	state.viewX = newX;
	state.viewY = newY;
}
