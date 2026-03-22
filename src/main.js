import * as THREE from "three";
import {
  getAllTeams,
  doAction,
  getGameParams,
  getMap,
  getModules,
  getPlans,
  getShips,
  getTeam,
  getTeamIdFromToken
} from "./api.js";
import { animateMap, highlightCell, highlightPlanet, highlightShip, renderMap } from "./mapRenderer.js";
import { preloadAllModels } from "./models.js";
import { getPlanetOwnerId, normalizeTeamId } from "./ownership.js";
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
  setLoading,
  showCellInfo,
  showPlanetInfo,
  showShipInfo,
  updateCoords,
  updateHUD,
  updateLeaderboard
} from "./ui.js";

let teamSelectIndex = 0;
let planetSelectIndex = -1;
const keys = {};
const moveAccumulator = { x: 0, y: 0 };
let movementPlanTimer = null;
let processingMovementPlan = false;

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
    const selection = getSelectionFromState();
    if (selection) {
      applySelection(selection);
    }
    updateCoords(
      state.fullMapMode ? "GLOBAL" : state.viewX,
      state.fullMapMode ? "58x58" : state.viewY
    );
    drawMinimap(state.mapCells);
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

function movementCellKey(coordX, coordY) {
  return `${coordX}_${coordY}`;
}

function getCurrentShipById(shipId) {
  if (!shipId) {
    return null;
  }

  return state.myTeam?.vaisseaux?.find((ship) => ship.idVaisseau === shipId) || null;
}

function getShipMoveRange(ship) {
  const rawSpeed = ship?.type?.vitesse ?? ship?.vitesse ?? 1;
  const numericSpeed = Number.parseInt(rawSpeed, 10);
  return Number.isFinite(numericSpeed) && numericSpeed > 0 ? numericSpeed : 1;
}

function getActionReadyDelay(ship) {
  if (!ship?.dateProchaineAction) {
    return 0;
  }

  const nextDate = new Date(ship.dateProchaineAction);
  if (Number.isNaN(nextDate.getTime())) {
    return 0;
  }

  return Math.max(0, nextDate.getTime() - Date.now() + 250);
}

async function getCellsForPathfinding() {
  const expectedCellCount = state.mapWorldSize * state.mapWorldSize;
  if (state.mapCells.length >= expectedCellCount) {
    return state.mapCells;
  }

  return fetchWholeMap();
}

function buildMovementLookup(cells) {
  const lookup = new Map();
  (cells || []).forEach((cell) => {
    lookup.set(movementCellKey(cell.coord_x, cell.coord_y), cell);
  });
  return lookup;
}

function getMovementCell(lookup, coordX, coordY) {
  return lookup.get(movementCellKey(coordX, coordY)) || {
    coord_x: coordX,
    coord_y: coordY,
    proprietaire: null,
    planete: null,
    vaisseau: null
  };
}

function isTraversableMovementCell(cell, startKey, targetKey) {
  if (!cell) {
    return true;
  }

  const cellKey = movementCellKey(cell.coord_x, cell.coord_y);
  if (cellKey === startKey || cellKey === targetKey) {
    return true;
  }

  return !cell.planete || cell.planete.modelePlanete?.typePlanete === "VIDE";
}

function findShortestPath(startX, startY, targetX, targetY, cells) {
  if (
    startX === undefined ||
    startY === undefined ||
    targetX === undefined ||
    targetY === undefined
  ) {
    return null;
  }

  const startKey = movementCellKey(startX, startY);
  const targetKey = movementCellKey(targetX, targetY);

  if (startKey === targetKey) {
    return [{ coord_x: startX, coord_y: startY }];
  }

  const lookup = buildMovementLookup(cells);
  const queue = [[startX, startY]];
  const visited = new Set([startKey]);
  const previous = new Map();
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];

  while (queue.length > 0) {
    const [currentX, currentY] = queue.shift();
    const currentKey = movementCellKey(currentX, currentY);

    for (const [offsetX, offsetY] of directions) {
      const nextX = currentX + offsetX;
      const nextY = currentY + offsetY;

      if (
        nextX < 0 ||
        nextY < 0 ||
        nextX >= state.mapWorldSize ||
        nextY >= state.mapWorldSize
      ) {
        continue;
      }

      const nextKey = movementCellKey(nextX, nextY);
      if (visited.has(nextKey)) {
        continue;
      }

      const nextCell = getMovementCell(lookup, nextX, nextY);
      if (!isTraversableMovementCell(nextCell, startKey, targetKey)) {
        continue;
      }

      visited.add(nextKey);
      previous.set(nextKey, currentKey);

      if (nextKey === targetKey) {
        queue.length = 0;
        break;
      }

      queue.push([nextX, nextY]);
    }
  }

  if (!visited.has(targetKey)) {
    return null;
  }

  const path = [];
  let currentKey = targetKey;

  while (currentKey) {
    const [coordX, coordY] = currentKey.split("_").map((value) => Number.parseInt(value, 10));
    path.push({ coord_x: coordX, coord_y: coordY });
    currentKey = previous.get(currentKey);
  }

  return path.reverse();
}

function clearMovementPlan(message = "", type = "info") {
  clearTimeout(movementPlanTimer);
  movementPlanTimer = null;
  state.movementPlan = null;

  if (message) {
    notify(message, type);
  }
}

function scheduleMovementPlanRetry(delayMs = 500) {
  clearTimeout(movementPlanTimer);

  if (!state.movementPlan) {
    movementPlanTimer = null;
    return;
  }

  movementPlanTimer = setTimeout(() => {
    processMovementPlan().catch((error) => {
      console.error(error);
      clearMovementPlan(`Trajet interrompu : ${error.message}`, "error");
    });
  }, Math.max(350, delayMs));
}

async function planShipMovement(ship, targetX, targetY) {
  const currentShip = getCurrentShipById(ship?.idVaisseau) || ship;
  if (!currentShip) {
    notify("Vaisseau introuvable", "error");
    clearPendingAction();
    return false;
  }

  if (currentShip.positionX === targetX && currentShip.positionY === targetY) {
    clearPendingAction();
    notify("Le vaisseau est déjà sur cette case", "info");
    return false;
  }

  const cells = await getCellsForPathfinding();
  const path = findShortestPath(
    currentShip.positionX,
    currentShip.positionY,
    targetX,
    targetY,
    cells
  );

  clearPendingAction();

  if (!path) {
    notify("Aucun chemin disponible jusqu'à cette case", "error");
    return false;
  }

  clearTimeout(movementPlanTimer);
  movementPlanTimer = null;
  state.movementPlan = {
    shipId: currentShip.idVaisseau,
    shipName: currentShip.nom || "Vaisseau",
    targetX,
    targetY
  };
  const readyDelay = getActionReadyDelay(currentShip);

  notify(
    `Trajet défini vers (${targetX}, ${targetY}) · ${Math.max(0, path.length - 1)} cases`,
    "success"
  );

  if (readyDelay > 0) {
    notify(
      `${currentShip.nom || "Le vaisseau"} est en cooldown : le trajet dÃ©marrera automatiquement dÃ¨s qu'il sera disponible`,
      "info"
    );
  }

  await processMovementPlan();
  return true;
}

async function processMovementPlan() {
  if (processingMovementPlan || !state.movementPlan) {
    return;
  }

  processingMovementPlan = true;
  clearTimeout(movementPlanTimer);
  movementPlanTimer = null;

  try {
    const plan = state.movementPlan;
    const ship = getCurrentShipById(plan.shipId) || state.selectedShip;

    if (!ship || ship.idVaisseau !== plan.shipId) {
      clearMovementPlan("Trajet annulé : vaisseau introuvable", "error");
      return;
    }

    if (ship.positionX === plan.targetX && ship.positionY === plan.targetY) {
      clearMovementPlan(`Trajet terminé pour ${ship.nom || "le vaisseau"}`, "success");
      return;
    }

    const readyDelay = getActionReadyDelay(ship);
    if (readyDelay > 0) {
      scheduleMovementPlanRetry(readyDelay);
      return;
    }

    const cells = await getCellsForPathfinding();
    const path = findShortestPath(
      ship.positionX,
      ship.positionY,
      plan.targetX,
      plan.targetY,
      cells
    );

    if (!path) {
      clearMovementPlan("Aucun chemin disponible jusqu'à cette case", "error");
      return;
    }

    const preferredWaypointIndex = Math.min(path.length - 1, getShipMoveRange(ship));
    const nextWaypoint = path[preferredWaypointIndex];
    if (
      !nextWaypoint ||
      (nextWaypoint.coord_x === ship.positionX && nextWaypoint.coord_y === ship.positionY)
    ) {
      clearMovementPlan(`Trajet terminé pour ${ship.nom || "le vaisseau"}`, "success");
      return;
    }

    let response;
    try {
      response = await doAction(
        state.teamId,
        ship.idVaisseau,
        "DEPLACEMENT",
        nextWaypoint.coord_x,
        nextWaypoint.coord_y
      );
    } catch (error) {
      const message = `${error.message || ""}`.toLowerCase();
      const fallbackWaypoint = path[1];
      const shouldRetryWithNearestStep =
        message.includes("hors de portée") ||
        message.includes("hors de portee");

      if (
        shouldRetryWithNearestStep &&
        preferredWaypointIndex > 1 &&
        fallbackWaypoint &&
        (
          fallbackWaypoint.coord_x !== nextWaypoint.coord_x ||
          fallbackWaypoint.coord_y !== nextWaypoint.coord_y
        )
      ) {
        response = await doAction(
          state.teamId,
          ship.idVaisseau,
          "DEPLACEMENT",
          fallbackWaypoint.coord_x,
          fallbackWaypoint.coord_y
        );
      } else {
        throw error;
      }
    }

    if (response?.message) {
      notify(`DEPLACEMENT : ${response.message}`, "success");
    }

    await fullSync();

    if (!state.movementPlan || state.movementPlan.shipId !== plan.shipId) {
      return;
    }

    const refreshedShip = getCurrentShipById(plan.shipId) || ship;
    if (refreshedShip.positionX === plan.targetX && refreshedShip.positionY === plan.targetY) {
      clearMovementPlan(`Trajet terminé pour ${refreshedShip.nom || "le vaisseau"}`, "success");
      return;
    }

    scheduleMovementPlanRetry(getActionReadyDelay(refreshedShip) || 400);
  } catch (error) {
    clearMovementPlan(`Trajet interrompu : ${error.message}`, "error");
  } finally {
    processingMovementPlan = false;
  }
}

async function refreshAllTeams() {
  try {
    const [teamSummaries, ships, modules, plans, gameParams] = await Promise.all([
      getAllTeams(),
      getShips(state.teamId),
      getModules(state.teamId),
      getPlans(state.teamId),
      getGameParams().catch(() => [])
    ]);

    const teamDetails = await Promise.allSettled(
      (teamSummaries || [])
        .map((team) => normalizeTeamId(team))
        .filter(Boolean)
        .map((teamId) => getTeam(teamId))
    );

    state.allTeams = (teamSummaries || []).map((team, index) => {
      const detail = teamDetails[index];
      if (detail?.status !== "fulfilled") {
        return {
          ...team,
          planetes: team.planetes || []
        };
      }

      return {
        ...team,
        ...detail.value,
        modules: detail.value?.modules || team.modules || [],
        vaisseaux: detail.value?.vaisseaux || team.vaisseaux || [],
        planetes: detail.value?.planetes || team.planetes || [],
        ressources: detail.value?.ressources || team.ressources || []
      };
    });
    state.myPlans = plans || [];
    state.gameParams = gameParams || [];
    state.myTeam =
      state.allTeams.find((team) => team.idEquipe === state.teamId) || {
        idEquipe: state.teamId,
        nom: "Mon équipe",
        ressources: [],
        planetes: []
      };

    state.myTeam.vaisseaux = (ships || []).map((ship) => ({
      ...ship,
      proprietaire: ship.proprietaire || state.teamId
    }));
    state.myTeam.modules = modules || [];
    state.myTeam.planetes = state.myTeam.planetes || [];
    state.teamName = state.myTeam.nom || "";

    updateHUD(state.myTeam);
    updateLeaderboard(state.allTeams);

    if (state.selectedShip?.idVaisseau) {
      const refreshedShip = state.myTeam.vaisseaux.find((ship) => ship.idVaisseau === state.selectedShip.idVaisseau);
      if (refreshedShip) {
        applySelection(buildSelectionForShip(refreshedShip));
      }
    }

    if (state.movementPlan && !processingMovementPlan && !movementPlanTimer) {
      const plannedShip = getCurrentShipById(state.movementPlan.shipId);
      if (plannedShip) {
        scheduleMovementPlanRetry(getActionReadyDelay(plannedShip) || 250);
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
    const ownerId = getPlanetOwnerId(cell.planete, {
      cell,
      mapCells: state.mapCells,
      teams: state.allTeams,
      myTeam: state.myTeam,
      selectedCell: state.selectedCell
    });
    const payload = {
      key,
      x: cell.coord_x,
      y: cell.coord_y,
      ownerId,
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

function createCellStub(coordX, coordY, overrides = {}) {
  return {
    coord_x: coordX ?? 0,
    coord_y: coordY ?? 0,
    proprietaire: null,
    planete: null,
    vaisseau: null,
    ...overrides
  };
}

function normalizeCell(cell) {
  if (!cell) {
    return null;
  }

  return createCellStub(cell.coord_x, cell.coord_y, {
    proprietaire: cell.proprietaire ?? null,
    planete: cell.planete ?? null,
    vaisseau: cell.vaisseau ?? null
  });
}

function findCellByCoords(coordX, coordY) {
  if (coordX === undefined || coordY === undefined) {
    return null;
  }

  return state.mapCells.find((cell) => cell.coord_x === coordX && cell.coord_y === coordY) || null;
}

function findCellByShipId(shipId) {
  if (!shipId) {
    return null;
  }

  return state.mapCells.find((cell) => cell.vaisseau?.idVaisseau === shipId) || null;
}

function findCellByPlanetId(planetId) {
  if (!planetId) {
    return null;
  }

  return state.mapCells.find((cell) => cell.planete?.identifiant === planetId) || null;
}

function normalizeShip(ship, cell = null) {
  if (!ship) {
    return null;
  }

  return {
    ...ship,
    proprietaire: normalizeTeamId(ship.proprietaire) || normalizeTeamId(cell?.proprietaire),
    positionX: ship.positionX ?? cell?.coord_x ?? 0,
    positionY: ship.positionY ?? cell?.coord_y ?? 0
  };
}

function normalizePlanetFromCell(cell) {
  if (!cell?.planete) {
    return null;
  }

  const ownerId = getPlanetOwnerId(cell.planete, {
    cell,
    mapCells: state.mapCells,
    teams: state.allTeams,
    myTeam: state.myTeam,
    selectedCell: state.selectedCell
  });

  return {
    ...cell.planete,
    coord_x: cell.coord_x,
    coord_y: cell.coord_y,
    proprietaire: ownerId
  };
}

function getSelectedCraftPlanet() {
  if (state.selectedPlanet?.identifiant) {
    const selectedPlanetCell = findCellByPlanetId(state.selectedPlanet.identifiant);
    const normalizedPlanet = selectedPlanetCell
      ? normalizePlanetFromCell(selectedPlanetCell)
      : {
          ...state.selectedPlanet,
          proprietaire: getPlanetOwnerId(state.selectedPlanet, {
            mapCells: state.mapCells,
            teams: state.allTeams,
            myTeam: state.myTeam,
            selectedCell: state.selectedCell
          })
        };

    return normalizedPlanet?.proprietaire === state.teamId ? normalizedPlanet : null;
  }

  if (state.selectedCell?.planete) {
    const selectedPlanet = normalizePlanetFromCell(state.selectedCell);
    return selectedPlanet?.proprietaire === state.teamId ? selectedPlanet : null;
  }

  return null;
}

function updateCraftButtonState() {
  const craftButton = document.getElementById("craft-btn");
  if (!craftButton) {
    return;
  }

  const craftPlanet = getSelectedCraftPlanet();
  craftButton.disabled = !craftPlanet;
  craftButton.title = craftPlanet
    ? `Construire un vaisseau sur ${craftPlanet.nom || "la planète sélectionnée"}`
    : "Sélectionnez une de vos planètes pour construire";
}

function openCraftForSelection() {
  const craftPlanet = getSelectedCraftPlanet();
  if (!craftPlanet) {
    notify("Sélectionnez une de vos planètes pour construire", "error");
    return;
  }

  openShipBuilder(craftPlanet);
}

function isTypingTarget(target) {
  return Boolean(
    target &&
    (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable
    )
  );
}

function buildCellSelection(cell) {
  const normalizedCell = normalizeCell(cell);
  if (!normalizedCell) {
    return null;
  }

  return {
    type: "cell",
    cell: normalizedCell,
    ship: null,
    planet: null
  };
}

function buildShipSelectionFromCell(cell) {
  const normalizedCell = normalizeCell(cell);
  if (!normalizedCell?.vaisseau) {
    return buildCellSelection(normalizedCell);
  }

  return {
    type: "ship",
    cell: normalizedCell,
    ship: normalizeShip(normalizedCell.vaisseau, normalizedCell),
    planet: null
  };
}

function buildPlanetSelectionFromCell(cell) {
  const normalizedCell = normalizeCell(cell);
  if (!normalizedCell?.planete) {
    return buildCellSelection(normalizedCell);
  }

  return {
    type: "planet",
    cell: normalizedCell,
    ship: null,
    planet: normalizePlanetFromCell(normalizedCell)
  };
}

function buildSelectionFromCell(cell) {
  const normalizedCell = normalizeCell(cell);
  if (!normalizedCell) {
    return null;
  }

  if (normalizedCell.vaisseau) {
    return buildShipSelectionFromCell(normalizedCell);
  }

  if (normalizedCell.planete) {
    return buildPlanetSelectionFromCell(normalizedCell);
  }

  return buildCellSelection(normalizedCell);
}

function buildSelectionForShip(ship) {
  if (!ship) {
    return null;
  }

  const matchedCell =
    findCellByShipId(ship.idVaisseau) ||
    findCellByCoords(ship.positionX, ship.positionY);

  if (matchedCell?.vaisseau?.idVaisseau === ship.idVaisseau) {
    return buildShipSelectionFromCell(matchedCell);
  }

  return {
    type: "ship",
    cell: createCellStub(ship.positionX, ship.positionY, { vaisseau: normalizeShip(ship) }),
    ship: normalizeShip(ship),
    planet: null
  };
}

function buildSelectionForPlanet(planet) {
  if (!planet) {
    return null;
  }

  const matchedCell =
    findCellByPlanetId(planet.identifiant) ||
    findCellByCoords(planet.coord_x, planet.coord_y);

  if (matchedCell?.planete?.identifiant === planet.identifiant) {
    return buildPlanetSelectionFromCell(matchedCell);
  }

  const normalizedPlanet = {
    ...planet,
    coord_x: planet.coord_x ?? 0,
    coord_y: planet.coord_y ?? 0,
    proprietaire: getPlanetOwnerId(planet, {
      mapCells: state.mapCells,
      teams: state.allTeams,
      myTeam: state.myTeam,
      selectedCell: state.selectedCell
    })
  };

  return {
    type: "planet",
    cell: createCellStub(normalizedPlanet.coord_x, normalizedPlanet.coord_y, {
      proprietaire: normalizedPlanet.proprietaire,
      planete: normalizedPlanet
    }),
    ship: null,
    planet: normalizedPlanet
  };
}

function isSelectablePlanetCell(cell) {
  return Boolean(cell?.planete && cell.planete.modelePlanete?.typePlanete !== "VIDE");
}

async function getSelectablePlanetCells() {
  const cells = await getCellsForPathfinding();
  return [...(cells || [])]
    .filter((cell) => {
      if (!isSelectablePlanetCell(cell)) {
        return false;
      }

      const ownerId = getPlanetOwnerId(cell.planete, {
        cell,
        mapCells: cells,
        teams: state.allTeams,
        myTeam: state.myTeam,
        selectedCell: state.selectedCell
      });
      return ownerId === state.teamId;
    })
    .sort((left, right) =>
      left.coord_y === right.coord_y
        ? left.coord_x - right.coord_x
        : left.coord_y - right.coord_y
    );
}

function getSelectionFromState() {
  if (state.selectedShip?.idVaisseau) {
    return buildSelectionForShip(state.selectedShip);
  }

  if (state.selectedPlanet?.identifiant) {
    return buildSelectionForPlanet(state.selectedPlanet);
  }

  if (state.selectedCell) {
    return buildSelectionFromCell(
      findCellByCoords(state.selectedCell.coord_x, state.selectedCell.coord_y) || state.selectedCell
    );
  }

  return null;
}

function isSameSelectedCell(cell) {
  return Boolean(
    cell &&
    state.selectedCell &&
    state.selectedCell.coord_x === cell.coord_x &&
    state.selectedCell.coord_y === cell.coord_y
  );
}

function getClickSelection(cell) {
  const normalizedCell = normalizeCell(cell);
  if (!normalizedCell) {
    return null;
  }

  const hasShip = Boolean(normalizedCell.vaisseau);
  const hasPlanet = Boolean(normalizedCell.planete);

  if (hasShip && hasPlanet) {
    if (isSameSelectedCell(normalizedCell) && state.selectedShip?.idVaisseau === normalizedCell.vaisseau.idVaisseau) {
      return buildPlanetSelectionFromCell(normalizedCell);
    }

    if (isSameSelectedCell(normalizedCell) && state.selectedPlanet?.identifiant === normalizedCell.planete.identifiant) {
      return buildShipSelectionFromCell(normalizedCell);
    }

    return buildShipSelectionFromCell(normalizedCell);
  }

  return buildSelectionFromCell(normalizedCell);
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

function applySelection(selection) {
  clearCurrentSelection();

  if (!selection) {
    closeInfoPanel();
    return;
  }

  state.selectedCell = selection.cell || null;
  state.selectedShip = selection.ship || null;
  state.selectedPlanet = selection.planet || null;

  if (state.selectedCell) {
    highlightCell(state.selectedCell.coord_x, state.selectedCell.coord_y, true);
  }

  if (state.selectedShip?.idVaisseau) {
    highlightShip(state.selectedShip.idVaisseau, true);
    showShipInfo(state.selectedShip);
    return;
  }

  if (state.selectedPlanet?.identifiant) {
    highlightPlanet(state.selectedPlanet.identifiant, true);
    showPlanetInfo(state.selectedPlanet);
    return;
  }

  showCellInfo(state.selectedCell);
}

async function handlePrimaryMapClick(event, element, raycaster, mouse) {
  const rect = element.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);

  const clickedCell = getCellFromRay(raycaster);
  const selection = clickedCell ? getClickSelection(clickedCell) : null;

  if (state.pendingAction) {
    if (clickedCell) {
      if (state.pendingAction.action === "DEPLACEMENT") {
        await planShipMovement(state.pendingAction.vaisseau, clickedCell.coord_x, clickedCell.coord_y);
      } else {
        const executed = await executePendingAction(clickedCell.coord_x, clickedCell.coord_y);
        if (executed) {
          await fullSync();
        }
      }
    }
    return;
  }

  applySelection(selection);
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
    refreshMap();
    return;
  }

  centerViewOnFleet();
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
  const refreshButton = document.getElementById("refresh-btn");

  refreshButton.addEventListener("click", async () => {
    refreshButton.disabled = true;
    refreshButton.textContent = "Sync...";
    await fullSync();
    refreshButton.textContent = "Sync";
    refreshButton.disabled = false;
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

function registerInput() {
  window.addEventListener("keydown", (event) => {
    keys[event.key] = true;

    if (event.key === "Escape") {
      if (state.movementPlan) {
        clearMovementPlan("Trajet annulé", "info");
      }
      clearCurrentSelection();
      clearPendingAction();
      closeInfoPanel();
    }

    if (event.key === "Tab") {
      event.preventDefault();
      selectShipByIndex(event.shiftKey ? teamSelectIndex - 1 : teamSelectIndex + 1);
    }

    if (event.key.toLowerCase() === "p" && !isTypingTarget(event.target)) {
      event.preventDefault();
      selectPlanetByDirection(event.shiftKey ? -1 : 1);
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
  applySelection(buildSelectionForShip(ship));

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

async function selectPlanetByDirection(direction) {
  try {
    const planetCells = await getSelectablePlanetCells();
    if (!planetCells.length) {
      notify("Aucune de vos planetes disponible", "error");
      return;
    }

    const currentPlanetId =
      state.selectedPlanet?.identifiant ||
      state.selectedCell?.planete?.identifiant ||
      null;

    const currentIndex = currentPlanetId
      ? planetCells.findIndex((cell) => cell.planete?.identifiant === currentPlanetId)
      : planetSelectIndex;

    const nextIndex = currentIndex >= 0
      ? ((currentIndex + direction) % planetCells.length + planetCells.length) % planetCells.length
      : direction < 0
        ? planetCells.length - 1
        : 0;

    planetSelectIndex = nextIndex;

    const selectedCell = planetCells[nextIndex];
    const selectedPlanet = normalizePlanetFromCell(selectedCell);
    applySelection(buildPlanetSelectionFromCell(selectedCell));

    if (selectedPlanet?.coord_x !== undefined && selectedPlanet?.coord_y !== undefined) {
      if (state.fullMapMode) {
        focusOnShip(selectedPlanet.coord_x, selectedPlanet.coord_y);
        return;
      }

      state.viewX = Math.max(
        0,
        Math.min(58 - state.viewSize, selectedPlanet.coord_x - Math.floor(state.viewSize / 2))
      );
      state.viewY = Math.max(
        0,
        Math.min(58 - state.viewSize, selectedPlanet.coord_y - Math.floor(state.viewSize / 2))
      );
      focusOnShip(selectedPlanet.coord_x, selectedPlanet.coord_y);
      scheduleMapRefresh();
    }
  } catch (error) {
    notify(`Erreur planÃ¨tes: ${error.message}`, "error");
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
