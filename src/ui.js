import {
  buildShip,
  buyOffer,
  createOffer,
  deleteOffer,
  doAction,
  getMarketOffers,
  getModules,
  getPlans,
  placeModule,
  removeModule,
  renameShip
} from "./api.js";
import { getTeamColor } from "./mapRenderer.js";
import { getPlanetOwnerId, normalizeTeamId } from "./ownership.js";
import { state } from "./state.js";

function fmt(value) {
  if (value === undefined || value === null || Number.isNaN(value)) {
    return "?";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}

function getResource(team, resourceName) {
  return (team?.ressources || []).find((entry) => entry.ressource?.nom === resourceName)?.quantite ?? 0;
}

function getGold(team) {
  return getResource(team, "CREDIT");
}

function isShipAvailable(ship) {
  if (!ship?.dateProchaineAction) {
    return true;
  }
  const nextDate = new Date(ship.dateProchaineAction);
  return Number.isNaN(nextDate.getTime()) || nextDate <= new Date();
}

function createShipName(plan) {
  const base = plan?.nom || plan?.typeVaisseau?.classeVaisseau || "Vaisseau";
  return `${base} ${Math.floor(100 + Math.random() * 900)}`;
}

function findCellForPlanet(planet) {
  if (!planet) {
    return null;
  }

  if (
    state.selectedCell?.planete?.identifiant &&
    planet.identifiant &&
    state.selectedCell.planete.identifiant === planet.identifiant
  ) {
    return state.selectedCell;
  }

  if (planet.identifiant) {
    const matchedById = state.mapCells.find((cell) => cell.planete?.identifiant === planet.identifiant);
    if (matchedById) {
      return matchedById;
    }
  }

  if (planet.coord_x !== undefined && planet.coord_y !== undefined) {
    return state.mapCells.find((cell) => cell.coord_x === planet.coord_x && cell.coord_y === planet.coord_y) || null;
  }

  return null;
}

function ownerIdOfPlanet(planet) {
  const cell = findCellForPlanet(planet);
  return getPlanetOwnerId(planet, {
    cell,
    selectedCell: state.selectedCell,
    mapCells: state.mapCells,
    teams: state.allTeams,
    myTeam: state.myTeam
  });
}

function getTeamById(teamId) {
  const normalizedTeamId = normalizeTeamId(teamId);
  if (!normalizedTeamId) {
    return null;
  }

  if (normalizedTeamId === state.teamId) {
    return state.myTeam || state.allTeams.find((team) => team.idEquipe === normalizedTeamId) || null;
  }

  return state.allTeams.find((team) => team.idEquipe === normalizedTeamId) || null;
}

function getOwnershipDetails(ownerId) {
  const normalizedOwnerId = normalizeTeamId(ownerId);
  if (!normalizedOwnerId) {
    return {
      ownerName: "Aucun propriétaire"
    };
  }

  const team = getTeamById(normalizedOwnerId);
  return {
    ownerName: normalizedOwnerId === state.teamId
      ? `${state.teamName || team?.nom || "Votre équipe"} (vous)`
      : team?.nom || `Équipe ${normalizedOwnerId.slice(0, 8)}`
  };
}

export function notify(message, type = "info") {
  const container = document.getElementById("notifications");
  const element = document.createElement("div");
  element.className = `notif${type === "info" ? "" : ` ${type}`}`;
  element.textContent = message;
  container.appendChild(element);
  setTimeout(() => element.remove(), 3400);
}

export function setLoading(percent, status) {
  document.getElementById("loading-bar-fill").style.width = `${percent}%`;
  if (status) {
    document.getElementById("loading-status").textContent = status;
  }
}

export function hideLoading() {
  const overlay = document.getElementById("loading");
  overlay.style.transition = "opacity 0.45s ease";
  overlay.style.opacity = "0";
  setTimeout(() => overlay.remove(), 520);
}

export function updateCoords(x, y) {
  document.getElementById("coords-display").textContent = `[ X:${x} Y:${y} ]`;
}

export function updateHUD(team) {
  document.getElementById("res-minerai").textContent = fmt(getResource(team, "MINERAI"));
  document.getElementById("res-credits").textContent = fmt(getGold(team));
  document.getElementById("res-ships").textContent = fmt(getResource(team, "VAISSEAU"));
  document.getElementById("team-score-val").textContent = fmt(getResource(team, "POINT"));
}

export function updateLeaderboard(teams) {
  const list = document.getElementById("leaderboard-list");
  list.innerHTML = "";

  const header = document.createElement("div");
  header.className = "lb-row lb-head";
  header.innerHTML = `
    <span class="lb-rank">#</span>
    <span class="lb-color"></span>
    <span class="lb-name">Equipe</span>
    <span class="lb-gold" title="Gold">Gold</span>
    <span class="lb-pts">Pts</span>
  `;
  list.appendChild(header);

  [...teams]
    .sort((left, right) => getResource(right, "POINT") - getResource(left, "POINT"))
    .slice(0, 16)
    .forEach((team, index) => {
      const row = document.createElement("div");
      row.className = `lb-row${team.idEquipe === state.teamId ? " my-team" : ""}`;
      row.innerHTML = `
        <span class="lb-rank">${index + 1}</span>
        <span class="lb-color" style="background:#${getTeamColor(team.idEquipe).toString(16).padStart(6, "0")}"></span>
        <span class="lb-name" title="${team.nom}">${team.nom}</span>
        <span class="lb-gold" title="Gold">${fmt(getGold(team))}</span>
        <span class="lb-pts">${fmt(getResource(team, "POINT"))}</span>
      `;
      list.appendChild(row);
    });
}

function setPortrait(icon, name, subtitle, hpRatio) {
  document.getElementById("portrait-icon").textContent = icon;
  document.getElementById("portrait-name").textContent = name || "---";
  document.getElementById("portrait-subtitle").textContent = subtitle || "";

  const bar = document.getElementById("portrait-hp-bar");
  const fill = document.getElementById("portrait-hp-fill");

  if (hpRatio === null || hpRatio === undefined) {
    bar.style.display = "none";
    fill.style.width = "100%";
    return;
  }

  bar.style.display = "block";
  fill.style.width = `${Math.max(0, Math.min(100, hpRatio * 100))}%`;
  fill.style.background = hpRatio > 0.6 ? "#66ffb2" : hpRatio > 0.3 ? "#ffd76a" : "#ff667f";
}

function setStats(rows) {
  const container = document.getElementById("stats-content");
  container.innerHTML = rows
    .map(
      (row) => `
        <div class="stat-row">
          <span class="stat-key">${row.key}</span>
          <span class="stat-val${row.cls ? ` ${row.cls}` : ""}">${row.val}</span>
        </div>
      `
    )
    .join("");
}

function buildCommandCard(buttons) {
  const card = document.getElementById("command-card");
  card.innerHTML = "";

  for (let index = 0; index < 12; index += 1) {
    const button = buttons[index];
    if (!button) {
      const spacer = document.createElement("div");
      spacer.className = "cmd-btn spacer";
      card.appendChild(spacer);
      continue;
    }

    const element = document.createElement("button");
    element.className = `cmd-btn${button.active ? " active-action" : ""}`;
    element.disabled = Boolean(button.disabled);
    element.innerHTML = `${button.icon}<div class="cmd-label">${button.label}</div>`;
    element.title = button.tooltip || button.label;
    element.addEventListener("click", button.action);
    card.appendChild(element);
  }
}

export function showShipInfo(ship) {
  if (!ship) {
    return closeInfoPanel();
  }

  const currentHp = ship.pointDeVie ?? 0;
  const maxHp = ship.type?.pointDeVie ?? Math.max(currentHp, 1);
  const hpRatio = maxHp > 0 ? currentHp / maxHp : 0;
  const isMine = ship.proprietaire === state.teamId;
  const available = isShipAvailable(ship);
  const ownership = getOwnershipDetails(ship.proprietaire);

  setPortrait(
    "🚀",
    ship.nom,
    ship.type?.classeVaisseau || ship.type?.nom || "Vaisseau",
    hpRatio
  );

  setStats([
    { key: "PV", val: `${fmt(currentHp)} / ${fmt(maxHp)}`, cls: hpRatio > 0.6 ? "good" : hpRatio > 0.3 ? "warn" : "bad" },
    { key: "ATTAQUE", val: fmt(ship.type?.attaque) },
    { key: "CARGO", val: `${fmt(ship.mineraiTransporte ?? 0)} / ${fmt(ship.type?.capaciteTransport ?? 0)}` },
    { key: "POSITION", val: `(${fmt(ship.positionX)}, ${fmt(ship.positionY)})` },
    { key: "ÉQUIPE", val: ownership.ownerName },
    { key: "STATUT", val: available ? "PRÊT" : "COOLDOWN", cls: available ? "good" : "warn" }
  ]);

  if (!isMine) {
    buildCommandCard([]);
    return;
  }

  buildCommandCard([
    {
      icon: "🏃",
      label: "Déplacer",
      active: state.pendingAction?.action === "DEPLACEMENT",
      action: () => setPendingAction({ action: "DEPLACEMENT", vaisseau: ship })
    },
    {
      icon: "⛏",
      label: "Récolter",
      disabled: !available,
      active: state.pendingAction?.action === "RECOLTER",
      action: () => setPendingAction({ action: "RECOLTER", vaisseau: ship })
    },
    {
      icon: "📦",
      label: "Déposer",
      disabled: !available,
      active: state.pendingAction?.action === "DEPOSER",
      action: () => setPendingAction({ action: "DEPOSER", vaisseau: ship })
    },
    {
      icon: "⚔",
      label: "Attaquer",
      disabled: !available,
      active: state.pendingAction?.action === "ATTAQUER",
      action: () => setPendingAction({ action: "ATTAQUER", vaisseau: ship })
    },
    {
      icon: "🏴",
      label: "Conquérir",
      disabled: !available,
      active: state.pendingAction?.action === "CONQUERIR",
      action: () => setPendingAction({ action: "CONQUERIR", vaisseau: ship })
    },
    {
      icon: "🔧",
      label: "Réparer",
      disabled: !available,
      active: state.pendingAction?.action === "REPARER",
      action: () => setPendingAction({ action: "REPARER", vaisseau: ship })
    },
    {
      icon: "✏",
      label: "Renommer",
      action: () => openRenameModal(ship)
    }
  ]);
}

let lastPlanetId = null;
let planetPanelMode = "overview";

export function refreshSelectedPlanet(mapCells) {
  if (!lastPlanetId) {
    return;
  }

  const cell = mapCells.find((item) => item.planete?.identifiant === lastPlanetId);
  if (cell?.planete) {
    showPlanetInfo({
      ...cell.planete,
      coord_x: cell.coord_x,
      coord_y: cell.coord_y,
      proprietaire: cell.proprietaire
    }, { mode: planetPanelMode });
  }
}

function renderPlanetOverviewStats(planet, ownership) {
  const hp = planet.pointDeVie ?? 0;

  setStats([
    { key: "PV", val: fmt(hp), cls: hp > 100 ? "good" : hp > 0 ? "warn" : "bad" },
    { key: "MINERAI", val: fmt(planet.mineraiDisponible ?? 0) },
    { key: "SLOTS", val: `${(planet.modules || []).length} / ${fmt(planet.slotsConstruction ?? 0)}` },
    { key: "COORD", val: `(${fmt(planet.coord_x)}, ${fmt(planet.coord_y)})` },
    { key: "Ã‰QUIPE", val: ownership.ownerName }
  ]);
}

function renderPlanetCommandCard(planet, isMine) {
  if (!isMine) {
    buildCommandCard([]);
    return;
  }

  buildCommandCard([
    {
      icon: "i",
      label: "Infos",
      active: planetPanelMode === "overview",
      action: () => showPlanetInfo(planet, { mode: "overview" })
    },
    {
      icon: "M",
      label: "Modules",
      active: planetPanelMode === "modules",
      action: () => showPlanetInfo(planet, { mode: "modules" })
    },
    {
      icon: "ðŸ”¨",
      label: "Construire",
      action: () => openShipBuilder(planet)
    }
  ]);
}

export function showPlanetInfo(planet, options = {}) {
  if (!planet) {
    return closeInfoPanel();
  }

  lastPlanetId = planet.identifiant;
  const hp = planet.pointDeVie ?? 0;
  const hpRatio = Math.max(0, Math.min(1, hp / Math.max(hp, 100)));
  const ownerId = ownerIdOfPlanet(planet);
  const isMine = ownerId === state.teamId;
  const ownership = getOwnershipDetails(ownerId);
  planetPanelMode = isMine && options.mode === "modules" ? "modules" : "overview";

  setPortrait(
    "P",
    planet.nom,
    `${planet.modelePlanete?.typePlanete || "--"} / ${planet.modelePlanete?.biome || "--"}`,
    hpRatio
  );

  if (planetPanelMode === "modules") {
    renderModulesInStats(planet);
  } else {
    renderPlanetOverviewStats(planet, ownership);
  }

  renderPlanetCommandCard(planet, isMine);
  return;

  setPortrait(
    "ðŸŒ",
    planet.nom,
    `${planet.modelePlanete?.typePlanete || "--"} Â· ${planet.modelePlanete?.biome || "--"}`,
    hpRatio
  );

  if (planetPanelMode === "modules") {
    renderModulesInStats(planet);
  } else {
    renderPlanetOverviewStats(planet, ownership);
  }

  renderPlanetCommandCard(planet, isMine);
  return;

  setPortrait(
    "🌍",
    planet.nom,
    `${planet.modelePlanete?.typePlanete || "--"} · ${planet.modelePlanete?.biome || "--"}`,
    hpRatio
  );

  setStats([
    { key: "PV", val: fmt(hp), cls: hp > 100 ? "good" : hp > 0 ? "warn" : "bad" },
    { key: "MINERAI", val: fmt(planet.mineraiDisponible ?? 0) },
    { key: "SLOTS", val: `${modules.length} / ${fmt(planet.slotsConstruction ?? 0)}` },
    { key: "COORD", val: `(${fmt(planet.coord_x)}, ${fmt(planet.coord_y)})` },
    { key: "ÉQUIPE", val: ownership.ownerName }
  ]);

  if (!isMine) {
    buildCommandCard([]);
    return;
  }

  renderModulesInStats(planet);
  buildCommandCard([
    {
      icon: "◈",
      label: "Modules",
      action: () => renderModulesInStats(planet)
    },
    {
      icon: "🔨",
      label: "Construire",
      action: () => openShipBuilder(planet)
    }
  ]);
}

export function showCellInfo(cell) {
  if (!cell) {
    return closeInfoPanel();
  }

  const ownerId = cell.planete
    ? ownerIdOfPlanet(cell.planete)
    : normalizeTeamId(cell.proprietaire);
  const ownership = getOwnershipDetails(ownerId);
  const content = cell.planete
    ? `PlanÃ¨te ${cell.planete.nom || ""}`.trim()
    : cell.vaisseau
      ? `Vaisseau ${cell.vaisseau.nom || ""}`.trim()
      : "Vide";

  setPortrait("â—»", `Case ${cell.coord_x},${cell.coord_y}`, content, null);
  setStats([
    { key: "COORD", val: `(${fmt(cell.coord_x)}, ${fmt(cell.coord_y)})` },
    { key: "Ã‰QUIPE", val: ownership.ownerName },
    { key: "CONTENU", val: content }
  ]);
  buildCommandCard([]);
}

function resolvePlanetDetails(planet) {
  if (!planet?.identifiant) {
    return planet;
  }

  const detailedPlanet =
    (state.myTeam?.planetes || []).find((item) => item.identifiant === planet.identifiant) ||
    planet;

  const placedModulesFromInventory = (state.myTeam?.modules || []).filter(
    (module) => module.idPlanete === planet.identifiant
  );
  const mergedModules = [
    ...(detailedPlanet.modules || []),
    ...placedModulesFromInventory
  ];

  const dedupedModules = [];
  const seenModuleIds = new Set();
  mergedModules.forEach((module) => {
    const moduleId = module?.id || module?.paramModule?.id || `${module?.paramModule?.typeModule || "module"}_${dedupedModules.length}`;
    if (seenModuleIds.has(moduleId)) {
      return;
    }

    seenModuleIds.add(moduleId);
    dedupedModules.push(module);
  });

  return {
    ...planet,
    ...detailedPlanet,
    modules: dedupedModules
  };
}

async function renderModulesInStats(planet) {
  const container = document.getElementById("stats-content");
  container.innerHTML = "";

  const resolvedPlanet = resolvePlanetDetails(planet);
  const placed = resolvedPlanet.modules || [];
  const available = (state.myTeam?.modules || []).filter((module) => !module.idPlanete);

  if (placed.length === 0 && available.length === 0) {
    container.innerHTML = `<div class="helper-text">Aucun module disponible pour cette planète.</div>`;
    return;
  }

  placed.forEach((module) => {
    const row = document.createElement("div");
    row.className = "stat-row";
    row.innerHTML = `
      <span class="stat-key">◈ ${module.paramModule?.typeModule || "MODULE"}</span>
      <span class="stat-val bad" title="Retirer">RETIRER</span>
    `;
    row.querySelector(".stat-val").addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await removeModule(state.teamId, module.id);
        notify(`Module ${module.paramModule?.typeModule || module.id} retiré`, "success");
        state.myTeam.modules = await getModules(state.teamId);
        await state.actions.fullSync?.();
      } catch (error) {
        notify(error.message, "error");
      }
    });
    container.appendChild(row);
  });

  available.forEach((module) => {
    const row = document.createElement("div");
    row.className = "stat-row";
    row.innerHTML = `
      <span class="stat-key">+ ${module.paramModule?.typeModule || "MODULE"}</span>
      <span class="stat-val good" title="Poser">POSER</span>
    `;
    row.querySelector(".stat-val").addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await placeModule(state.teamId, module.id, resolvedPlanet.identifiant);
        notify(`Module ${module.paramModule?.typeModule || module.id} posé`, "success");
        state.myTeam.modules = await getModules(state.teamId);
        await state.actions.fullSync?.();
      } catch (error) {
        notify(error.message, "error");
      }
    });
    container.appendChild(row);
  });
}

export function closeInfoPanel() {
  lastPlanetId = null;
  state.selectedShip = null;
  state.selectedPlanet = null;
  state.selectedCell = null;
  clearPendingAction();
  setPortrait("◈", "---", "Aucune sélection", null);
  document.getElementById("stats-content").innerHTML = "";
  buildCommandCard([]);
}

let minimapContext = null;

export function initMinimap() {
  const canvas = document.getElementById("minimap");
  minimapContext = canvas.getContext("2d");
  canvas.addEventListener("click", onMinimapClick);
}

export function drawMinimap(cells) {
  if (!minimapContext) {
    return;
  }

  const canvas = minimapContext.canvas;
  const width = canvas.width;
  const height = canvas.height;
  const cellWidth = width / 58;
  const cellHeight = height / 58;

  minimapContext.clearRect(0, 0, width, height);
  minimapContext.fillStyle = "#020a15";
  minimapContext.fillRect(0, 0, width, height);

  state.minimapPlanets.forEach((planet) => {
    minimapContext.fillStyle = planet.ownerId
      ? `#${getTeamColor(planet.ownerId).toString(16).padStart(6, "0")}`
      : "#23394d";
    minimapContext.fillRect(planet.x * cellWidth, planet.y * cellHeight, Math.max(2, cellWidth), Math.max(2, cellHeight));
  });

  cells.forEach((cell) => {
    if (!cell.vaisseau) {
      return;
    }
    minimapContext.fillStyle = `#${getTeamColor(cell.vaisseau.proprietaire).toString(16).padStart(6, "0")}`;
    minimapContext.beginPath();
    minimapContext.arc(
      cell.coord_x * cellWidth + cellWidth / 2,
      cell.coord_y * cellHeight + cellHeight / 2,
      2,
      0,
      Math.PI * 2
    );
    minimapContext.fill();
  });

  minimapContext.strokeStyle = "rgba(87, 208, 255, 0.92)";
  minimapContext.lineWidth = 1;
  if (!state.fullMapMode) {
    minimapContext.strokeRect(
      state.viewX * cellWidth,
      state.viewY * cellHeight,
      state.viewSize * cellWidth,
      state.viewSize * cellHeight
    );
  }
}

function onMinimapClick(event) {
  if (state.fullMapMode) {
    return;
  }

  const rect = event.target.getBoundingClientRect();
  const ratioX = (event.clientX - rect.left) / rect.width;
  const ratioY = (event.clientY - rect.top) / rect.height;
  const coordX = Math.floor(ratioX * 58);
  const coordY = Math.floor(ratioY * 58);

  state.viewX = Math.max(0, Math.min(58 - state.viewSize, coordX - Math.floor(state.viewSize / 2)));
  state.viewY = Math.max(0, Math.min(58 - state.viewSize, coordY - Math.floor(state.viewSize / 2)));
  state.actions.refreshMap?.();
}

export function setPendingAction(pendingAction) {
  state.pendingAction = pendingAction;
  document.getElementById("crosshair-indicator").classList.add("visible");
  document.getElementById("crosshair-label").textContent = `Cible pour ${pendingAction.action}`;
  if (state.selectedShip) {
    showShipInfo(state.selectedShip);
  }
  notify(`Sélectionnez la case cible pour ${pendingAction.action}`, "info");
}

export function clearPendingAction() {
  state.pendingAction = null;
  document.getElementById("crosshair-indicator").classList.remove("visible");
}

export async function executePendingAction(coordX, coordY) {
  const pendingAction = state.pendingAction;
  if (!pendingAction) {
    return false;
  }

  clearPendingAction();

  try {
    const response = await doAction(
      state.teamId,
      pendingAction.vaisseau.idVaisseau,
      pendingAction.action,
      coordX,
      coordY
    );

    const message = response?.message
      ? `${pendingAction.action} : ${response.message}`
      : `${pendingAction.action} envoyé sur (${coordX}, ${coordY})`;
    notify(message, "success");
    return true;
  } catch (error) {
    notify(error.message, "error");
    return false;
  }
}

function normalizeOfferStatus(status) {
  return String(status || "").trim().toUpperCase();
}

function isOfferOpen(status) {
  const normalizedStatus = normalizeOfferStatus(status);
  return normalizedStatus === "OUVERTE" || normalizedStatus === "DISPONIBLE";
}

function getOfferStatusLabel(status) {
  const normalizedStatus = normalizeOfferStatus(status);

  if (normalizedStatus === "OUVERTE" || normalizedStatus === "DISPONIBLE") {
    return "OUVERTE";
  }

  if (normalizedStatus === "FERMEE" || normalizedStatus === "VENDU") {
    return "FERMEE";
  }

  if (normalizedStatus === "ABANDON" || normalizedStatus === "ANNULE") {
    return "ABANDON";
  }

  return normalizedStatus || "?";
}

function getOfferAvailability(offer) {
  if (!offer?.dateDisponibilite) {
    return {
      isAvailable: true,
      label: ""
    };
  }

  const availableAt = new Date(offer.dateDisponibilite);
  if (Number.isNaN(availableAt.getTime())) {
    return {
      isAvailable: true,
      label: ""
    };
  }

  return {
    isAvailable: availableAt.getTime() <= Date.now(),
    label: availableAt.toLocaleString("fr-FR", {
      dateStyle: "short",
      timeStyle: "short"
    })
  };
}

function getOfferDisplayName(offer) {
  if (offer?.typeObjet === "PLAN") {
    return offer.plan?.nom || offer.plan?.typeVaisseau?.classeVaisseau || offer.idObjet || "Plan";
  }

  return offer.module?.paramModule?.typeModule || offer.idObjet || "Module";
}

function getOfferGroupKey(offer) {
  const sellerId = normalizeTeamId(offer?.idVendeur) || "unknown";
  const itemType = String(offer?.typeObjet || "OBJET").trim().toUpperCase();
  const itemSignature = itemType === "PLAN"
    ? offer?.plan?.typeVaisseau?.id || offer?.plan?.nom || offer?.idObjet || "unknown"
    : offer?.module?.paramModule?.id || offer?.module?.paramModule?.typeModule || offer?.idObjet || "unknown";

  return `${sellerId}|${itemType}|${String(itemSignature).trim().toUpperCase()}`;
}

function isPreferredOffer(candidate, current) {
  if (!current) {
    return true;
  }

  const candidateOpen = isOfferOpen(candidate?.statut);
  const currentOpen = isOfferOpen(current?.statut);
  if (candidateOpen !== currentOpen) {
    return candidateOpen;
  }

  const candidateAvailable = getOfferAvailability(candidate).isAvailable;
  const currentAvailable = getOfferAvailability(current).isAvailable;
  if (candidateAvailable !== currentAvailable) {
    return candidateAvailable;
  }

  const candidatePrice = Number(candidate?.prix ?? Number.POSITIVE_INFINITY);
  const currentPrice = Number(current?.prix ?? Number.POSITIVE_INFINITY);
  if (candidatePrice !== currentPrice) {
    return candidatePrice < currentPrice;
  }

  const candidateDate = new Date(candidate?.dateMiseEnVente || 0).getTime();
  const currentDate = new Date(current?.dateMiseEnVente || 0).getTime();
  return candidateDate < currentDate;
}

function dedupeMarketOffers(offers) {
  const groups = new Map();

  (offers || []).forEach((offer) => {
    const key = getOfferGroupKey(offer);
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        ...offer,
        offerCount: 1
      });
      return;
    }

    const preferredOffer = isPreferredOffer(offer, existing) ? offer : existing;
    groups.set(key, {
      ...preferredOffer,
      offerCount: existing.offerCount + 1
    });
  });

  return [...groups.values()];
}

function getSellableModules(modules) {
  return (modules || []).filter((module) => !module.idPlanete);
}

function updateMarketSummary(offers, modules, plans) {
  const summary = document.getElementById("market-summary");
  if (!summary) {
    return;
  }

  const openOffers = (offers || []).filter((offer) => isOfferOpen(offer.statut));
  const buyableOffers = openOffers.filter((offer) => {
    const sellerId = normalizeTeamId(offer.idVendeur);
    return sellerId !== state.teamId && getOfferAvailability(offer).isAvailable;
  });

  summary.innerHTML = `
    <div class="market-summary-item">
      <span class="market-summary-label">Votre gold</span>
      <strong>${fmt(getGold(state.myTeam))}</strong>
    </div>
    <div class="market-summary-item">
      <span class="market-summary-label">Offres ouvertes</span>
      <strong>${fmt(openOffers.length)}</strong>
    </div>
    <div class="market-summary-item">
      <span class="market-summary-label">Achetables</span>
      <strong>${fmt(buyableOffers.length)}</strong>
    </div>
    <div class="market-summary-item">
      <span class="market-summary-label">Modules a vendre</span>
      <strong>${fmt(getSellableModules(modules).length)}</strong>
    </div>
    <div class="market-summary-item">
      <span class="market-summary-label">Plans a vendre</span>
      <strong>${fmt((plans || []).length)}</strong>
    </div>
  `;
}

function updateSellFormState(type, modules, plans) {
  const helper = document.getElementById("sell-helper");
  const confirmButton = document.getElementById("sell-confirm-btn");
  if (!helper || !confirmButton) {
    return;
  }

  const moduleCount = getSellableModules(modules).length;
  const planCount = (plans || []).length;
  const hasItems = type === "PLAN" ? planCount > 0 : moduleCount > 0;

  confirmButton.disabled = !hasItems;
  helper.textContent = hasItems
    ? ""
    : type === "PLAN"
      ? "Aucun plan disponible a mettre en vente."
      : "Aucun module libre disponible a mettre en vente.";
}

export async function openMarket() {
  const modal = document.getElementById("market-modal");
  modal.classList.remove("hidden");

  const loading = document.getElementById("market-loading");
  const list = document.getElementById("market-list");
  const summary = document.getElementById("market-summary");
  const typeSelect = document.getElementById("sell-object-type");
  const moduleGroup = document.getElementById("sell-module-group");
  const planGroup = document.getElementById("sell-plan-group");
  const moduleSelect = document.getElementById("sell-module-select");
  const planSelect = document.getElementById("sell-plan-select");
  const sellHelper = document.getElementById("sell-helper");
  const sellButton = document.getElementById("sell-confirm-btn");

  loading.style.display = "block";
  list.innerHTML = "";
  if (summary) {
    summary.innerHTML = "";
  }
  if (sellHelper) {
    sellHelper.textContent = "";
  }
  moduleSelect.innerHTML = `<option value="">-- Sélectionner un module --</option>`;
  planSelect.innerHTML = `<option value="">-- Sélectionner un plan --</option>`;

  let currentModules = [];
  let currentPlans = [];

  const toggleSellFields = () => {
    const isPlan = typeSelect.value === "PLAN";
    moduleGroup.style.display = isPlan ? "none" : "flex";
    planGroup.style.display = isPlan ? "flex" : "none";
    updateSellFormState(typeSelect.value, currentModules, currentPlans);
  };

  typeSelect.onchange = toggleSellFields;
  toggleSellFields();

  try {
    const [offers, modules, plans] = await Promise.all([
      getMarketOffers(),
      getModules(state.teamId),
      getPlans(state.teamId)
    ]);
    const visibleOffers = dedupeMarketOffers(offers);

    state.myTeam = state.myTeam || { ressources: [], modules: [] };
    currentModules = modules || [];
    currentPlans = plans || [];
    state.myTeam.modules = currentModules;
    state.myPlans = currentPlans;
    updateMarketSummary(visibleOffers, currentModules, currentPlans);

    getSellableModules(state.myTeam.modules)
      .forEach((module) => {
        const option = document.createElement("option");
        option.value = module.id;
        option.textContent = module.paramModule?.typeModule || module.id;
        moduleSelect.appendChild(option);
      });

    (state.myPlans || []).forEach((plan) => {
      const option = document.createElement("option");
      option.value = plan.id;
      option.textContent = plan.nom || plan.typeVaisseau?.classeVaisseau || plan.id;
      planSelect.appendChild(option);
    });

    updateSellFormState(typeSelect.value, currentModules, currentPlans);

    loading.style.display = "none";

    if (!visibleOffers.length) {
      list.innerHTML = `<div class="helper-text">Aucune offre visible pour le moment.</div>`;
    } else {
      [...visibleOffers]
        .sort((left, right) => {
          const leftOpen = isOfferOpen(left.statut) ? 1 : 0;
          const rightOpen = isOfferOpen(right.statut) ? 1 : 0;
          if (leftOpen !== rightOpen) {
            return rightOpen - leftOpen;
          }

          return (left.prix ?? 0) - (right.prix ?? 0);
        })
        .forEach((offer) => {
        const sellerId = normalizeTeamId(offer.idVendeur);
        const sellerTeam = getTeamById(sellerId);
        const isOwnOffer = sellerId === state.teamId;
        const offerStatus = normalizeOfferStatus(offer.statut);
        const isOpen = isOfferOpen(offerStatus);
        const availability = getOfferAvailability(offer);
        const offerLabel = `${offer.typeObjet === "PLAN" ? "PLAN" : "MODULE"} · ${getOfferDisplayName(offer)}`;
        const quantityLabel = offer.offerCount > 1 ? `${offer.offerCount} exemplaires` : "1 exemplaire";

        const row = document.createElement("div");
        row.className = "market-offer";
        row.innerHTML = `
          <span class="offer-type">${offerLabel}</span>
          <span class="offer-seller">${isOwnOffer ? "VOUS" : (sellerTeam?.nom || (sellerId || "").slice(0, 8))}</span>
          <span class="offer-price">${fmt(offer.prix)} cr</span>
          <span class="offer-status ${offerStatus}">${getOfferStatusLabel(offerStatus)}</span>
          <span class="offer-meta">${quantityLabel}${availability.label ? ` · Disponible ${availability.label}` : " · Disponible maintenant"}</span>
        `;

        if (!isOwnOffer && isOpen && availability.isAvailable) {
          const button = document.createElement("button");
          button.className = "btn-buy";
          button.textContent = offer.offerCount > 1 ? "Acheter 1" : "Acheter";
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              await buyOffer(offer.idOffre);
              notify("Achat confirmé", "success");
              await state.actions.refreshAll?.();
              await openMarket();
            } catch (error) {
              notify(error.message, "error");
              button.disabled = false;
            }
          });
          row.appendChild(button);
        }

        if (!isOwnOffer && isOpen && !availability.isAvailable) {
          const button = document.createElement("button");
          button.className = "btn-buy";
          button.textContent = "Bientot";
          button.disabled = true;
          row.appendChild(button);
        }

        if (isOwnOffer && isOpen) {
          const button = document.createElement("button");
          button.className = "btn-buy";
          button.textContent = offer.offerCount > 1 ? "Annuler 1" : "Annuler";
          button.style.borderColor = "rgba(255, 102, 127, 0.38)";
          button.style.color = "#ff667f";
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              await deleteOffer(offer.idOffre);
              notify("Offre supprimée", "success");
              await state.actions.refreshAll?.();
              await openMarket();
            } catch (error) {
              notify(error.message, "error");
              button.disabled = false;
            }
          });
          row.appendChild(button);
        }

        list.appendChild(row);
        });
    }
  } catch (error) {
    loading.style.display = "none";
    if (summary) {
      summary.innerHTML = "";
    }
    list.innerHTML = `<div class="helper-text">${error.message}</div>`;
  }

  const replacement = sellButton.cloneNode(true);
  sellButton.parentNode.replaceChild(replacement, sellButton);
  updateSellFormState(typeSelect.value, currentModules, currentPlans);

  replacement.addEventListener("click", async () => {
    const price = Number.parseInt(document.getElementById("sell-price-input").value, 10);
    const type = typeSelect.value;
    const selectedObjectId = type === "PLAN"
      ? document.getElementById("sell-plan-select").value
      : document.getElementById("sell-module-select").value;

    if (!selectedObjectId) {
      notify("Sélectionnez un objet à vendre", "error");
      return;
    }

    if (!price || price < 1) {
      notify("Prix invalide", "error");
      return;
    }

    replacement.disabled = true;

    try {
      await createOffer({
        idObjet: selectedObjectId,
        prix: price,
        publique: true,
        visiblePar: [],
        typeObjet: type
      });
      notify("Offre créée", "success");
      document.getElementById("sell-price-input").value = "";
      await state.actions.refreshAll?.();
      await openMarket();
    } catch (error) {
      notify(error.message, "error");
      replacement.disabled = false;
    }
  });
}

let builderPlanet = null;
let selectedPlan = null;

export async function craftShipFromPlan(planet, plan, shipName = "") {
  if (!planet?.identifiant) {
    throw new Error("Planète invalide");
  }

  if (!plan?.typeVaisseau?.id) {
    throw new Error("Plan invalide");
  }

  await buildShip(state.teamId, {
    nom: shipName.trim() || createShipName(plan),
    idTypeVaisseau: plan.typeVaisseau.id,
    idPlanete: planet.identifiant
  });

  notify("Construction lancée", "success");
  await state.actions.refreshAll?.();
  await state.actions.refreshMap?.();
}

export async function openShipBuilder(planet) {
  const resolvedPlanet = resolvePlanetDetails(planet);
  builderPlanet = resolvedPlanet;
  selectedPlan = null;

  document.getElementById("builder-modal").classList.remove("hidden");
  document.getElementById("builder-planet-label").textContent = `Planète: ${planet.nom}`;
  document.getElementById("builder-list").innerHTML = `<div class="helper-text">Chargement des plans...</div>`;

  const constructionTypes = new Set(
    (resolvedPlanet.modules || [])
      .flatMap((module) => module.paramModule?.listeVaisseauxConstructible || [])
      .map((type) => type.id)
      .filter(Boolean)
  );

  const hint = document.getElementById("builder-hint");
  if (constructionTypes.size > 0) {
    hint.textContent = "Plans compatibles avec les modules de chantier présents sur la planète.";
  } else {
    hint.textContent = "Aucun module de chantier compatible détecté. L'API refusera la construction si nécessaire.";
  }

  try {
    const plans = state.myPlans.length ? state.myPlans : await getPlans(state.teamId);
    const compatibleClasses = [...new Set(
      (resolvedPlanet.modules || [])
        .flatMap((module) => module.paramModule?.listeVaisseauxConstructible || [])
        .map((type) => type.classeVaisseau || type.nom || type.id)
        .filter(Boolean)
    )];
    const buildablePlans = constructionTypes.size > 0 || compatibleClasses.length > 0
      ? plans.filter((plan) =>
          constructionTypes.has(plan.typeVaisseau?.id) ||
          compatibleClasses.includes(plan.typeVaisseau?.classeVaisseau) ||
          compatibleClasses.includes(plan.typeVaisseau?.nom)
        )
      : plans;
    const ownedPlanClasses = [...new Set(
      plans
        .map((plan) => plan.typeVaisseau?.classeVaisseau || plan.nom)
        .filter(Boolean)
    )];

    state.myPlans = plans;
    const list = document.getElementById("builder-list");
    list.innerHTML = "";

    if (!buildablePlans.length) {
      if (compatibleClasses.length) {
        hint.textContent = `Chantier sur ${resolvedPlanet.nom}: ${compatibleClasses.join(", ")}. Plans possÃ©dÃ©s: ${ownedPlanClasses.join(", ") || "aucun"}.`;
      }
      list.innerHTML = `<div class="helper-text">Aucun plan constructible depuis cette planète.</div>`;
      return;
    }

    buildablePlans.forEach((plan) => {
      const row = document.createElement("div");
      row.className = "plan-row";
      row.innerHTML = `
        <span class="plan-name">${plan.nom || plan.typeVaisseau?.classeVaisseau || "Plan"}</span>
        <div class="plan-stats">
          <span>ATK <span>${fmt(plan.typeVaisseau?.attaque)}</span></span>
          <span>PV <span>${fmt(plan.typeVaisseau?.pointDeVie)}</span></span>
          <span>CARGO <span>${fmt(plan.typeVaisseau?.capaciteTransport)}</span></span>
          <span>COÛT <span>${fmt(plan.typeVaisseau?.coutConstruction)}</span></span>
        </div>
      `;
      row.addEventListener("click", () => {
        list.querySelectorAll(".plan-row").forEach((element) => element.classList.remove("selected"));
        row.classList.add("selected");
        selectedPlan = plan;
      });
      list.appendChild(row);

      if (buildablePlans.length === 1) {
        row.classList.add("selected");
        selectedPlan = plan;
      }
    });
  } catch (error) {
    document.getElementById("builder-list").innerHTML = `<div class="helper-text">${error.message}</div>`;
  }

  const confirmButton = document.getElementById("builder-confirm");
  const replacement = confirmButton.cloneNode(true);
  confirmButton.parentNode.replaceChild(replacement, confirmButton);

  replacement.addEventListener("click", async () => {
    if (!selectedPlan) {
      notify("Sélectionnez un plan", "error");
      return;
    }

    replacement.disabled = true;

    try {
      await craftShipFromPlan(builderPlanet, selectedPlan);
      document.getElementById("builder-modal").classList.add("hidden");
    } catch (error) {
      notify(error.message, "error");
      replacement.disabled = false;
    }
  });
}

function openRenameModal(ship) {
  const modal = document.getElementById("rename-modal");
  const input = document.getElementById("rename-input");
  const confirmButton = document.getElementById("rename-confirm");

  modal.classList.remove("hidden");
  input.value = ship.nom || "";
  input.focus();
  input.select();

  const replacement = confirmButton.cloneNode(true);
  confirmButton.parentNode.replaceChild(replacement, confirmButton);

  const handleRename = async () => {
    const nextName = input.value.trim();
    if (!nextName) {
      notify("Nom invalide", "error");
      return;
    }

    replacement.disabled = true;
    try {
      const updated = await renameShip(state.teamId, ship.idVaisseau, nextName);
      ship.nom = updated?.nom || nextName;
      notify("Vaisseau renommé", "success");
      modal.classList.add("hidden");
      showShipInfo(ship);
      await state.actions.refreshAll?.();
    } catch (error) {
      notify(error.message, "error");
      replacement.disabled = false;
    }
  };

  replacement.addEventListener("click", handleRename);
  input.onkeydown = (event) => {
    if (event.key === "Enter") {
      handleRename();
    }
  };
}
