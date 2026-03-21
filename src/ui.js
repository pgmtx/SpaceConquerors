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

function normalizeTeamId(teamId) {
  if (!teamId) {
    return null;
  }

  if (typeof teamId === "string") {
    return teamId;
  }

  return teamId.idEquipe || teamId.teamId || teamId.id || null;
}

function ownerIdOfPlanet(planet) {
  return normalizeTeamId(planet?.proprietaire);
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
  if (!ownerId) {
    return {
      ownerName: "Aucun propriétaire"
    };
  }

  const team = getTeamById(ownerId);
  return {
    ownerName: ownerId === state.teamId
      ? `${state.teamName || team?.nom || "Votre équipe"} (vous)`
      : team?.nom || `Équipe ${ownerId.slice(0, 8)}`
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
  document.getElementById("res-credits").textContent = fmt(getResource(team, "CREDIT"));
  document.getElementById("res-ships").textContent = fmt(getResource(team, "VAISSEAU"));
  document.getElementById("team-score-val").textContent = fmt(getResource(team, "POINT"));
}

export function updateLeaderboard(teams) {
  const list = document.getElementById("leaderboard-list");
  list.innerHTML = "";

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
      disabled: !available,
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
    });
  }
}

export function showPlanetInfo(planet) {
  if (!planet) {
    return closeInfoPanel();
  }

  lastPlanetId = planet.identifiant;
  const modules = planet.modules || [];
  const hp = planet.pointDeVie ?? 0;
  const hpRatio = Math.max(0, Math.min(1, hp / Math.max(hp, 100)));
  const ownerId = ownerIdOfPlanet(planet);
  const isMine = ownerId === state.teamId;
  const ownership = getOwnershipDetails(ownerId);

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

  const ownerId = cell.proprietaire?.idEquipe || null;
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

async function renderModulesInStats(planet) {
  const container = document.getElementById("stats-content");
  container.innerHTML = "";

  const placed = planet.modules || [];
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
        await placeModule(state.teamId, module.id, planet.identifiant);
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

export async function openMarket() {
  const modal = document.getElementById("market-modal");
  modal.classList.remove("hidden");

  const loading = document.getElementById("market-loading");
  const list = document.getElementById("market-list");
  const typeSelect = document.getElementById("sell-object-type");
  const moduleGroup = document.getElementById("sell-module-group");
  const planGroup = document.getElementById("sell-plan-group");
  const moduleSelect = document.getElementById("sell-module-select");
  const planSelect = document.getElementById("sell-plan-select");

  loading.style.display = "block";
  list.innerHTML = "";
  moduleSelect.innerHTML = `<option value="">-- Sélectionner un module --</option>`;
  planSelect.innerHTML = `<option value="">-- Sélectionner un plan --</option>`;

  (state.myTeam?.modules || [])
    .filter((module) => !module.idPlanete)
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

  const toggleSellFields = () => {
    const isPlan = typeSelect.value === "PLAN";
    moduleGroup.style.display = isPlan ? "none" : "flex";
    planGroup.style.display = isPlan ? "flex" : "none";
  };

  typeSelect.onchange = toggleSellFields;
  toggleSellFields();

  try {
    const offers = await getMarketOffers();
    loading.style.display = "none";

    if (!offers?.length) {
      list.innerHTML = `<div class="helper-text">Aucune offre visible pour le moment.</div>`;
    } else {
      offers.forEach((offer) => {
        const isOwnOffer = offer.idVendeur === state.teamId;
        const offerLabel = offer.typeObjet === "PLAN"
          ? `PLAN · ${offer.plan?.nom || offer.plan?.typeVaisseau?.classeVaisseau || offer.idObjet}`
          : `MODULE · ${offer.module?.paramModule?.typeModule || offer.idObjet}`;

        const row = document.createElement("div");
        row.className = "market-offer";
        row.innerHTML = `
          <span class="offer-type">${offerLabel}</span>
          <span class="offer-seller">${isOwnOffer ? "VOUS" : (offer.idVendeur || "").slice(0, 8)}</span>
          <span class="offer-price">${fmt(offer.prix)} cr</span>
          <span class="offer-status ${offer.statut || ""}">${offer.statut || "?"}</span>
        `;

        if (!isOwnOffer && offer.statut === "DISPONIBLE") {
          const button = document.createElement("button");
          button.className = "btn-buy";
          button.textContent = "Acheter";
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

        if (isOwnOffer && offer.statut === "DISPONIBLE") {
          const button = document.createElement("button");
          button.className = "btn-buy";
          button.textContent = "Annuler";
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
    list.innerHTML = `<div class="helper-text">${error.message}</div>`;
  }

  const sellButton = document.getElementById("sell-confirm-btn");
  const replacement = sellButton.cloneNode(true);
  sellButton.parentNode.replaceChild(replacement, sellButton);

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

export async function openShipBuilder(planet) {
  builderPlanet = planet;
  selectedPlan = null;

  document.getElementById("builder-modal").classList.remove("hidden");
  document.getElementById("builder-planet-label").textContent = `Planète: ${planet.nom}`;
  document.getElementById("builder-list").innerHTML = `<div class="helper-text">Chargement des plans...</div>`;

  const constructionTypes = new Set(
    (planet.modules || [])
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
    const buildablePlans = constructionTypes.size > 0
      ? plans.filter((plan) => constructionTypes.has(plan.typeVaisseau?.id))
      : plans;

    state.myPlans = plans;
    const list = document.getElementById("builder-list");
    list.innerHTML = "";

    if (!buildablePlans.length) {
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
      await buildShip(state.teamId, {
        nom: createShipName(selectedPlan),
        idTypeVaisseau: selectedPlan.typeVaisseau?.id,
        idPlanete: builderPlanet.identifiant
      });
      notify("Construction lancée", "success");
      document.getElementById("builder-modal").classList.add("hidden");
      await state.actions.refreshAll?.();
      await state.actions.refreshMap?.();
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
