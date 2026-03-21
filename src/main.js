import * as THREE from "three";
import {
  getAllTeams,
  getGameParams,
  getMap,
  getModules,
  getPlans,
  getShips,
  getTeamIdFromToken
} from "./api.js";
import { animateMap, getClickedObject, highlightCell, highlightPlanet, highlightShip, renderMap } from "./mapRenderer.js";
import { preloadAllModels } from "./models.js";
import { camera, focusOnShip, focusOnWholeMap, initScene, panCameraTo, render, renderer } from "./scene.js";
import { state } from "./state.js";
import {
  clearPendingAction,
  closeInfoPanel,
  drawMinimap,
  executePendingAction,
  hideLoading,
  initMinimap,
  notify,
  openMarket,
  refreshSelectedPlanet,
  setLoading,
  showCellInfo,
  showPlanetInfo,
  showShipInfo,
  updateCoords,
  updateHUD,
  updateLeaderboard
} from "./ui.js";

let teamSelectIndex = 0;
const keys = {};
const moveAccumulator = { x: 0, y: 0 };

async function main() {
  setLoading(5, "Récupération du token de jeu...");

  const tokenPayload = await fetch("/token").then((response) => response.json()).catch(() => null);
  const token = tokenPayload?.access_token || "";

  if (!token) {
    setLoading(100, "Impossible de récupérer le token côté backend");
    return;
  }

  state.token = token;
  state.teamId = getTeamIdFromToken(token);

  if (!state.teamId) {
    setLoading(100, "Le token est invalide ou ne contient pas team_id");
    return;
  }

  setLoading(14, "Initialisation du cockpit 3D...");

  initScene(document.getElementById("canvas-container"));
  initMinimap();

  await preloadAllModels((loaded, total) => {
    setLoading(14 + (loaded / total) * 34, `Chargement des assets 3D ${loaded}/${total}`);
  });

  state.actions = {
    refreshMap,
    refreshAll: refreshAllTeams,
    fullSync: fullSync
  };

  setLoading(56, "Synchronisation avec l'API...");
  await fullSync();
  initializeMapView();

  setLoading(96, "Prêt au décollage");
  await new Promise((resolve) => setTimeout(resolve, 260));
  hideLoading();

  registerButtons();
  registerInput();
  startGameLoop();
  scheduleAutoSync();
}

async function fullSync() {
  await Promise.allSettled([refreshMap(), refreshAllTeams()]);
}

async function refreshMap() {
  try {
    const cells = state.fullMapMode
      ? await fetchWholeMap()
      : await getMap(
          state.viewX,
          state.viewX + state.viewSize - 1,
          state.viewY,
          state.viewY + state.viewSize - 1
        );

    state.mapCells = cells || [];
    updateMinimapData(state.mapCells);
    await renderMap(state.mapCells);
    if (state.selectedCell) {
      highlightCell(state.selectedCell.coord_x, state.selectedCell.coord_y, true);
    }
    updateCoords(
      state.fullMapMode ? "GLOBAL" : state.viewX,
      state.fullMapMode ? "58x58" : state.viewY
    );
    drawMinimap(state.mapCells);
    refreshSelectedPlanet(state.mapCells);
  } catch (error) {
    notify(`Erreur carte: ${error.message}`, "error");
  }
}

async function fetchWholeMap() {
  const chunkSize = 18;
  const ranges = [];

  for (let start = 0; start < state.mapWorldSize; start += chunkSize) {
    ranges.push([start, Math.min(state.mapWorldSize - 1, start + chunkSize - 1)]);
  }

  const chunks = await Promise.all(
    ranges.flatMap(([xStart, xEnd]) =>
      ranges.map(([yStart, yEnd]) => getMap(xStart, xEnd, yStart, yEnd))
    )
  );

  const merged = new Map();
  chunks.flat().forEach((cell) => {
    merged.set(`${cell.coord_x}_${cell.coord_y}`, cell);
  });

  return [...merged.values()].sort((left, right) =>
    left.coord_y === right.coord_y
      ? left.coord_x - right.coord_x
      : left.coord_y - right.coord_y
  );
}

async function refreshAllTeams() {
  try {
    const [teams, ships, modules, plans, gameParams] = await Promise.all([
      getAllTeams(),
      getShips(state.teamId),
      getModules(state.teamId),
      getPlans(state.teamId),
      getGameParams().catch(() => [])
    ]);

    state.allTeams = teams || [];
    state.myPlans = plans || [];
    state.gameParams = gameParams || [];
    state.myTeam =
      state.allTeams.find((team) => team.idEquipe === state.teamId) || {
        idEquipe: state.teamId,
        nom: "Mon équipe",
        ressources: []
      };

    state.myTeam.vaisseaux = (ships || []).map((ship) => ({
      ...ship,
      proprietaire: ship.proprietaire || state.teamId
    }));
    state.myTeam.modules = modules || [];
    state.teamName = state.myTeam.nom || "";

    updateHUD(state.myTeam);
    updateLeaderboard(state.allTeams);

    if (state.selectedShip?.idVaisseau) {
      const refreshedShip = state.myTeam.vaisseaux.find((ship) => ship.idVaisseau === state.selectedShip.idVaisseau);
      if (refreshedShip) {
        state.selectedShip = refreshedShip;
        showShipInfo(refreshedShip);
      }
    }
  } catch (error) {
    notify(`Erreur équipes: ${error.message}`, "error");
  }
}

function updateMinimapData(cells) {
  cells.forEach((cell) => {
    if (!cell.planete) {
      return;
    }

    const key = `${cell.coord_x}_${cell.coord_y}`;
    const payload = {
      key,
      x: cell.coord_x,
      y: cell.coord_y,
      ownerId: cell.proprietaire?.idEquipe || null,
      type: cell.planete.modelePlanete?.typePlanete || null
    };

    const index = state.minimapPlanets.findIndex((planet) => planet.key === key);
    if (index === -1) {
      state.minimapPlanets.push(payload);
    } else {
      state.minimapPlanets[index] = payload;
    }
  });
}

function getCellFromRay(raycaster) {
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const point = new THREE.Vector3();

  if (!raycaster.ray.intersectPlane(plane, point)) {
    return null;
  }

  const worldSize = state.mapWorldSize * 2;
  if (point.x < 0 || point.z < 0 || point.x >= worldSize || point.z >= worldSize) {
    return null;
  }

  const coordX = Math.floor(point.x / 2);
  const coordY = Math.floor(point.z / 2);

  return state.mapCells.find((cell) => cell.coord_x === coordX && cell.coord_y === coordY) || {
    coord_x: coordX,
    coord_y: coordY,
    proprietaire: null,
    planete: null,
    vaisseau: null
  };
}

function getSelectionFromCell(cell) {
  if (!cell) {
    return null;
  }

  if (cell.planete) {
    return {
      type: "planet",
      data: {
        ...cell.planete,
        coord_x: cell.coord_x,
        coord_y: cell.coord_y,
        proprietaire: cell.proprietaire
      }
    };
  }

  if (cell.vaisseau) {
    return {
      type: "ship",
      data: cell.vaisseau
    };
  }

  return {
    type: "cell",
    data: cell
  };
}

function clearCurrentSelection() {
  if (state.selectedCell) {
    highlightCell(state.selectedCell.coord_x, state.selectedCell.coord_y, false);
  }
  if (state.selectedShip?.idVaisseau) {
    highlightShip(state.selectedShip.idVaisseau, false);
  }
  if (state.selectedPlanet?.identifiant) {
    highlightPlanet(state.selectedPlanet.identifiant, false);
  }
}

function selectCell(cell) {
  clearCurrentSelection();
  state.selectedCell = cell;
  state.selectedPlanet = null;
  state.selectedShip = null;
  showCellInfo(cell);
  highlightCell(cell.coord_x, cell.coord_y, true);
}

function selectShip(ship) {
  clearCurrentSelection();
  state.selectedCell = null;
  state.selectedPlanet = null;
  state.selectedShip = ship;
  showShipInfo(ship);

  if (ship?.idVaisseau) {
    highlightShip(ship.idVaisseau, true);
  }
}

function selectPlanet(planet) {
  clearCurrentSelection();
  state.selectedCell = null;
  state.selectedShip = null;
  state.selectedPlanet = planet;
  showPlanetInfo(planet);

  if (planet?.identifiant) {
    highlightPlanet(planet.identifiant, true);
  }
}

async function handlePrimaryMapClick(event, element, raycaster, mouse) {
  const rect = element.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  const clickedCell = getCellFromRay(raycaster);
  const preciseHit = getClickedObject(raycaster);
  const hit = clickedCell ? { type: "cell", data: clickedCell } : (
    preciseHit?.type === "cell"
      ? { type: "cell", data: preciseHit.data }
      : preciseHit
  );

  if (state.pendingAction) {
    let coordX;
    let coordY;

    if (clickedCell) {
      coordX = clickedCell.coord_x;
      coordY = clickedCell.coord_y;
    } else if (hit?.type === "planet") {
      coordX = hit.data.coord_x;
      coordY = hit.data.coord_y;
    } else if (hit?.type === "ship") {
      coordX = hit.data.positionX;
      coordY = hit.data.positionY;
    }

    if (coordX !== undefined && coordY !== undefined) {
      const executed = await executePendingAction(coordX, coordY);
      if (executed) {
        await fullSync();
      }
      return;
    }
  }

  if (!hit) {
    clearCurrentSelection();
    closeInfoPanel();
    return;
  }

  if (hit.type === "cell") {
    selectCell(hit.data);
    return;
  }

  if (hit.type === "ship") {
    selectShip(hit.data);
    return;
  }

  if (hit.type === "planet") {
    selectPlanet(hit.data);
    return;
  }

  clearCurrentSelection();
  closeInfoPanel();
}

function centerViewOnFleet() {
  const firstShip = state.myTeam?.vaisseaux?.[0];
  if (!firstShip || firstShip.positionX === undefined || firstShip.positionY === undefined) {
    return;
  }

  state.viewX = Math.max(0, Math.min(58 - state.viewSize, firstShip.positionX - Math.floor(state.viewSize / 2)));
  state.viewY = Math.max(0, Math.min(58 - state.viewSize, firstShip.positionY - Math.floor(state.viewSize / 2)));
  panCameraTo(state.viewX, state.viewY, false);
  refreshMap();
}

function initializeMapView() {
  if (state.fullMapMode) {
    state.viewX = 0;
    state.viewY = 0;
    state.viewSize = state.mapWorldSize;
    focusOnWholeMap();
    updateMapModeButton();
    refreshMap();
    return;
  }

  centerViewOnFleet();
  updateMapModeButton();
}

function startGameLoop() {
  let previousTime = 0;

  const loop = (timestamp) => {
    const delta = (timestamp - previousTime) / 1000;
    previousTime = timestamp;

    handleKeyMovement(delta);
    animateMap(delta);
    render();
    requestAnimationFrame(loop);
  };

  requestAnimationFrame(loop);
}

function scheduleAutoSync() {
  let running = false;

  setInterval(async () => {
    if (running) {
      return;
    }

    running = true;
    await fullSync();
    running = false;
  }, 10000);
}

function registerButtons() {
  const mapModeButton = document.getElementById("map-mode-btn");
  const refreshButton = document.getElementById("refresh-btn");
  refreshButton.addEventListener("click", async () => {
    refreshButton.disabled = true;
    refreshButton.textContent = "Sync...";
    await fullSync();
    refreshButton.textContent = "Sync";
    refreshButton.disabled = false;
  });

  mapModeButton.addEventListener("click", async () => {
    state.fullMapMode = !state.fullMapMode;

    if (state.fullMapMode) {
      state.viewX = 0;
      state.viewY = 0;
      state.viewSize = state.mapWorldSize;
      focusOnWholeMap();
    } else {
      state.viewSize = 18;
      centerViewOnFleet();
    }

    updateMapModeButton();
    await refreshMap();
  });

  document.getElementById("lb-toggle").addEventListener("click", () => {
    document.getElementById("leaderboard").classList.toggle("hidden");
  });

  document.getElementById("market-btn").addEventListener("click", () => {
    openMarket();
  });

  ["market", "builder", "rename"].forEach((prefix) => {
    const modal = document.getElementById(`${prefix}-modal`);
    const closeButton = document.getElementById(`${prefix}-close`);
    closeButton?.addEventListener("click", () => modal.classList.add("hidden"));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) {
        modal.classList.add("hidden");
      }
    });
  });

  document.getElementById("builder-cancel").addEventListener("click", () => {
    document.getElementById("builder-modal").classList.add("hidden");
  });

  document.getElementById("rename-cancel").addEventListener("click", () => {
    document.getElementById("rename-modal").classList.add("hidden");
  });
}

function updateMapModeButton() {
  const button = document.getElementById("map-mode-btn");
  if (!button) {
    return;
  }

  button.textContent = state.fullMapMode ? "Vue Secteur" : "Carte Totale";
}

function registerInput() {
  window.addEventListener("keydown", (event) => {
    keys[event.key] = true;

    if (event.key === "Escape") {
      clearCurrentSelection();
      clearPendingAction();
      closeInfoPanel();
    }

    if (event.key === "Tab") {
      event.preventDefault();
      selectShipByIndex(event.shiftKey ? teamSelectIndex - 1 : teamSelectIndex + 1);
    }
  });

  window.addEventListener("keyup", (event) => {
    keys[event.key] = false;
  });

  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  const interactionState = {
    pointerId: null,
    startX: 0,
    startY: 0,
    moved: false
  };
  const clickThreshold = 6;
  const interactionSurface = renderer?.domElement || document.getElementById("canvas-container");

  const resetPointerState = (pointerId = null) => {
    if (pointerId !== null && interactionState.pointerId !== pointerId) {
      return;
    }

    interactionState.pointerId = null;
    interactionState.startX = 0;
    interactionState.startY = 0;
    interactionState.moved = false;
  };

  interactionSurface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    interactionState.pointerId = event.pointerId;
    interactionState.startX = event.clientX;
    interactionState.startY = event.clientY;
    interactionState.moved = false;
  });

  interactionSurface.addEventListener("pointermove", (event) => {
    if (event.pointerId !== interactionState.pointerId) {
      return;
    }

    if (
      Math.abs(event.clientX - interactionState.startX) > clickThreshold ||
      Math.abs(event.clientY - interactionState.startY) > clickThreshold
    ) {
      interactionState.moved = true;
    }
  });

  interactionSurface.addEventListener("pointercancel", (event) => {
    resetPointerState(event.pointerId);
  });

  interactionSurface.addEventListener("pointerup", async (event) => {
    if (event.button !== 0 || event.pointerId !== interactionState.pointerId) {
      return;
    }

    const moved = interactionState.moved;
    resetPointerState(event.pointerId);

    if (moved) {
      return;
    }

    await handlePrimaryMapClick(event, interactionSurface, raycaster, mouse);
  });
}

function selectShipByIndex(index) {
  const ships = state.myTeam?.vaisseaux || [];
  if (!ships.length) {
    notify("Aucun vaisseau disponible", "error");
    return;
  }

  teamSelectIndex = ((index % ships.length) + ships.length) % ships.length;
  const ship = ships[teamSelectIndex];
  selectShip(ship);

  if (ship.positionX !== undefined && ship.positionY !== undefined) {
    if (state.fullMapMode) {
      focusOnShip(ship.positionX, ship.positionY);
      return;
    }

    state.viewX = Math.max(0, Math.min(58 - state.viewSize, ship.positionX - Math.floor(state.viewSize / 2)));
    state.viewY = Math.max(0, Math.min(58 - state.viewSize, ship.positionY - Math.floor(state.viewSize / 2)));
    focusOnShip(ship.positionX, ship.positionY);
    scheduleMapRefresh();
  }
}

function handleKeyMovement(delta) {
  if (state.fullMapMode) {
    return;
  }

  const speed = 8 * delta;

  if (keys.ArrowLeft || keys.a || keys.A) {
    moveAccumulator.x -= speed;
  }
  if (keys.ArrowRight || keys.d || keys.D) {
    moveAccumulator.x += speed;
  }
  if (keys.ArrowUp || keys.w || keys.W) {
    moveAccumulator.y -= speed;
  }
  if (keys.ArrowDown || keys.s || keys.S) {
    moveAccumulator.y += speed;
  }

  let moved = false;

  if (Math.abs(moveAccumulator.x) >= 1) {
    const step = Math.sign(moveAccumulator.x) * Math.floor(Math.abs(moveAccumulator.x));
    state.viewX = Math.max(0, Math.min(58 - state.viewSize, state.viewX + step));
    moveAccumulator.x -= step;
    moved = true;
  }

  if (Math.abs(moveAccumulator.y) >= 1) {
    const step = Math.sign(moveAccumulator.y) * Math.floor(Math.abs(moveAccumulator.y));
    state.viewY = Math.max(0, Math.min(58 - state.viewSize, state.viewY + step));
    moveAccumulator.y -= step;
    moved = true;
  }

  if (moved) {
    panCameraTo(state.viewX, state.viewY);
    scheduleMapRefresh();
  }
}

let mapRefreshTimer = null;

function scheduleMapRefresh() {
  clearTimeout(mapRefreshTimer);
  mapRefreshTimer = setTimeout(() => {
    refreshMap();
  }, 180);
}

main().catch((error) => {
  console.error(error);
  notify(error.message, "error");
});
