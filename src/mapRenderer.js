import * as THREE from "three";
import { loadModuleModel, loadShipModel } from "./models.js";
import { getPlanetOwnerId, normalizeTeamId } from "./ownership.js";
import { scene, worldPos } from "./scene.js";
import { state } from "./state.js";

const TEAM_COLORS = [
  0x57d0ff,
  0xff5e7a,
  0x85a8ff,
  0xffb347,
  0x78ffcc,
  0xff9de1,
  0xb8ff6a,
  0xc694ff,
  0xfff36d,
  0x6de0ff
];

const BIOME_COLORS = {
  AQUATIQUE: { color: 0x1f73d8, emissive: 0x08142d },
  DESERTIQUE: { color: 0xc9924d, emissive: 0x2c1805 },
  VOLCANIQUE: { color: 0xc9462c, emissive: 0x340d04 },
  FORESTIERE: { color: 0x2e9d56, emissive: 0x071d10 },
  URBANISE: { color: 0x6f7f99, emissive: 0x121821 },
  GLACE: { color: 0xb9e1ff, emissive: 0x112238 },
  BASIQUE: { color: 0x7b61d7, emissive: 0x1c103c }
};

const TYPE_OVERRIDES = {
  TROU_NOIR: { color: 0x060606, emissive: 0x3a0c52, radius: 0.52 },
  TROU_DE_VER: { color: 0x6f37d9, emissive: 0x2d124b, radius: 0.52 },
  CHAMPS_ASTEROIDES: { color: 0x6f6b5d, emissive: 0x18150f, radius: 0.48 }
};

const cellObjects = new Map();
const shipObjects = new Map();

let selectedShipId = null;
let selectedPlanetId = null;
let selectedCellKey = null;

function blendHex(baseHex, targetHex, factor) {
  const base = new THREE.Color(baseHex);
  const target = new THREE.Color(targetHex);
  return base.lerp(target, factor).getHex();
}

export function getTeamColor(teamId) {
  const normalizedTeamId = normalizeTeamId(teamId);
  if (!normalizedTeamId) {
    return 0x2d415a;
  }

  if (normalizedTeamId === state.teamId) {
    return 0x57d0ff;
  }

  let hash = 0;
  for (const char of normalizedTeamId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return TEAM_COLORS[hash % TEAM_COLORS.length];
}

export function clearMap() {
  cellObjects.forEach(({ group }) => scene.remove(group));
  shipObjects.forEach((mesh) => scene.remove(mesh));
  cellObjects.clear();
  shipObjects.clear();
  selectedCellKey = null;
}

export async function renderMap(cells) {
  const visibleKeys = new Set();
  const visibleShipIds = new Set();

  for (const cell of cells) {
    const key = `${cell.coord_x}_${cell.coord_y}`;
    visibleKeys.add(key);

    let entry = cellObjects.get(key);
    if (!entry) {
      const group = new THREE.Group();
      group.position.copy(worldPos(cell.coord_x, cell.coord_y));
      scene.add(group);

      entry = { group, cell };
      cellObjects.set(key, entry);
      buildCellTile(group);
    }

    entry.cell = cell;
    entry.group.userData.cell = cell;
    updateCellTile(entry.group, cell);
    await syncPlanet(entry.group, cell);

    if (cell.vaisseau?.idVaisseau) {
      visibleShipIds.add(cell.vaisseau.idVaisseau);
      await placeShip(cell.vaisseau, cell.coord_x, cell.coord_y);
    }
  }

  cellObjects.forEach((entry, key) => {
    if (!visibleKeys.has(key)) {
      scene.remove(entry.group);
      cellObjects.delete(key);
    }
  });

  shipObjects.forEach((mesh, shipId) => {
    if (!visibleShipIds.has(shipId)) {
      scene.remove(mesh);
      shipObjects.delete(shipId);
    }
  });
}

function buildCellTile(group) {
  const tile = new THREE.Mesh(
    new THREE.PlaneGeometry(1.95, 1.95),
    new THREE.MeshLambertMaterial({
      color: 0x0a1528,
      transparent: true,
      opacity: 0.18
    })
  );
  tile.rotation.x = -Math.PI / 2;
  tile.position.y = -0.01;
  tile.userData.isTile = true;
  group.add(tile);
}

function updateCellTile(group, cell) {
  const tile = group.children.find((child) => child.userData.isTile);
  if (!tile) {
    return;
  }

  const ownerId = normalizeTeamId(cell.proprietaire) || (
    cell.planete
      ? getPlanetOwnerId(cell.planete, {
          cell,
          mapCells: state.mapCells,
          teams: state.allTeams,
          myTeam: state.myTeam,
          selectedCell: state.selectedCell
        })
      : null
  );
  const color = ownerId ? getTeamColor(ownerId) : 0x0a1528;
  tile.material.color.setHex(color);
  tile.material.opacity = ownerId ? 0.34 : 0.18;
  tile.material.emissive = new THREE.Color(ownerId ? color : 0x000000);
  tile.material.emissiveIntensity = ownerId ? 0.1 : 0;
}

async function syncPlanet(group, cell) {
  const previous = group.children.find((child) => child.userData.isPlanetContainer);
  if (previous) {
    group.remove(previous);
  }

  if (!cell.planete || cell.planete.modelePlanete?.typePlanete === "VIDE") {
    return;
  }

  const planetGroup = await buildPlanet(cell);
  group.add(planetGroup);
}

async function buildPlanet(cell) {
  const planet = {
    ...cell.planete,
    identifiant: cell.planete.identifiant,
    coord_x: cell.coord_x,
    coord_y: cell.coord_y,
    proprietaire: cell.proprietaire
  };

  const group = new THREE.Group();
  group.userData.isPlanetContainer = true;

  const type = planet.modelePlanete?.typePlanete;
  const biome = planet.modelePlanete?.biome;
  const override = TYPE_OVERRIDES[type];
  const palette = override || BIOME_COLORS[biome] || { color: 0x6c7b8d, emissive: 0x13202f };
  const radius = override?.radius || (type === "GAZEUSE" ? 0.62 : 0.48);
  const ownerId = getPlanetOwnerId(planet, {
    cell,
    mapCells: state.mapCells,
    teams: state.allTeams,
    myTeam: state.myTeam,
    selectedCell: state.selectedCell
  });
  const ownerColor = ownerId ? getTeamColor(ownerId) : null;
  const surfaceColor = ownerColor ? blendHex(palette.color, ownerColor, 0.82) : palette.color;
  const emissiveColor = ownerColor ? blendHex(palette.emissive, ownerColor, 0.4) : palette.emissive;

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 28, 18),
    new THREE.MeshPhongMaterial({
      color: surfaceColor,
      emissive: emissiveColor,
      emissiveIntensity: 0.38,
      shininess: type === "GAZEUSE" ? 36 : 18
    })
  );
  sphere.position.y = radius;
  sphere.castShadow = true;
  sphere.userData.isPlanet = true;
  sphere.userData.planete = planet;

  const hitArea = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.9, 18, 12),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false
    })
  );
  hitArea.position.y = radius;
  hitArea.userData.isPlanetHitArea = true;
  hitArea.userData.planete = planet;

  if (type === "GAZEUSE") {
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.08, 22, 16),
      new THREE.MeshLambertMaterial({
        color: ownerColor ? blendHex(palette.color, ownerColor, 0.86) : palette.color,
        transparent: true,
        opacity: 0.16,
        side: THREE.BackSide
      })
    );
    group.add(atmosphere);
  }

  if (type === "TROU_NOIR") {
    addRing(group, radius * 1.45, radius * 2.3, 0xb54fff, 0.58, 0.28);
  }

  if (type === "TROU_DE_VER") {
    addRing(group, radius * 1.28, radius * 1.9, 0x8f6eff, 0.72, 0.3);
  }

  if (ownerColor) {
    addRing(group, radius * 1.12, radius * 1.32, ownerColor, 0.6, 0.02);

    const light = new THREE.PointLight(ownerColor, 0.7, 3.4);
    light.position.set(0, radius * 2.3, 0);
    group.add(light);
  }

  await buildModuleIndicators(group, planet.modules || [], radius);

  group.add(sphere);
  group.add(hitArea);
  return group;
}

function addRing(group, inner, outer, color, opacity, y) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 42),
    new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = y;
  group.add(ring);
}

async function buildModuleIndicators(group, modules, radius) {
  const placements = modules.slice(0, 6);

  await Promise.all(
    placements.map(async (module, index) => {
      const model = await loadModuleModel(module.paramModule?.typeModule);
      const angle = (index / Math.max(placements.length, 1)) * Math.PI * 2;
      const orbitalRadius = radius * 1.55;
      model.position.set(
        Math.cos(angle) * orbitalRadius,
        radius * 0.72,
        Math.sin(angle) * orbitalRadius
      );
      model.rotation.y = -angle + Math.PI / 2;
      group.add(model);
    })
  );
}

async function placeShip(vaisseau, x, y) {
  const shipId = vaisseau.idVaisseau;
  const target = worldPos(x, y);
  target.y = 0.54;

  if (shipObjects.has(shipId)) {
    const existing = shipObjects.get(shipId);
    existing.userData.targetPos = target;
    existing.userData.vaisseau = vaisseau;
    return;
  }

  const classe = vaisseau.type?.classeVaisseau || "SONDE";
  const model = await loadShipModel(classe);
  model.position.copy(target);
  model.userData.isShip = true;
  model.userData.shipId = shipId;
  model.userData.vaisseau = vaisseau;
  model.userData.targetPos = target.clone();

  const emissiveColor = new THREE.Color(getTeamColor(vaisseau.proprietaire));
  model.traverse((child) => {
    if (child.isMesh && child.material) {
      if ("emissive" in child.material) {
        child.material.emissive = emissiveColor.clone();
        child.material.emissiveIntensity = vaisseau.proprietaire === state.teamId ? 0.34 : 0.14;
      }
    }
  });

  scene.add(model);
  shipObjects.set(shipId, model);
}

export function animateMap(delta) {
  const time = Date.now() * 0.001;

  cellObjects.forEach(({ group }) => {
    const sphere = group.children
      .find((child) => child.userData.isPlanetContainer)
      ?.children.find((child) => child.userData.isPlanet);

    if (sphere) {
      sphere.rotation.y += delta * 0.16;
    }
  });

  shipObjects.forEach((mesh) => {
    if (mesh.userData.targetPos) {
      mesh.position.lerp(mesh.userData.targetPos, 0.08);
    }
    mesh.position.y = 0.54 + Math.sin(time * 1.7 + mesh.position.x) * 0.05;
    mesh.rotation.y += delta * 0.35;
  });
}

export function getClickedObject(raycaster) {
  const shipMeshes = [];
  shipObjects.forEach((mesh) => {
    mesh.traverse((child) => {
      if (child.isMesh) {
        shipMeshes.push(child);
      }
    });
  });

  let hits = raycaster.intersectObjects(shipMeshes, false);
  if (hits.length > 0) {
    let current = hits[0].object;
    while (current && !current.userData.isShip) {
      current = current.parent;
    }
    if (current) {
      return { type: "ship", data: current.userData.vaisseau };
    }
  }

  const planetMeshes = [];
  cellObjects.forEach(({ group }) => {
    group.traverse((child) => {
      if (child.userData.isPlanet || child.userData.isPlanetHitArea) {
        planetMeshes.push(child);
      }
    });
  });

  hits = raycaster.intersectObjects(planetMeshes, false);
  if (hits.length > 0) {
    return { type: "planet", data: hits[0].object.userData.planete };
  }

  const tiles = [];
  cellObjects.forEach(({ group }) => {
    group.traverse((child) => {
      if (child.userData.isTile) {
        tiles.push(child);
      }
    });
  });

  hits = raycaster.intersectObjects(tiles, false);
  if (hits.length > 0) {
    return { type: "cell", data: hits[0].object.parent.userData.cell };
  }

  return null;
}

export function highlightPlanet(planetId, enabled) {
  if (selectedPlanetId && selectedPlanetId !== planetId) {
    const previous = findPlanetContainerById(selectedPlanetId);
    if (previous) {
      removePlanetSelectionRing(previous);
    }
  }

  const planetContainer = findPlanetContainerById(planetId);
  if (!planetContainer) {
    return;
  }

  if (enabled) {
    selectedPlanetId = planetId;
    addPlanetSelectionRing(planetContainer);
  } else {
    if (selectedPlanetId === planetId) {
      selectedPlanetId = null;
    }
    removePlanetSelectionRing(planetContainer);
  }
}

export function highlightCell(coordX, coordY, enabled) {
  const cellKey = `${coordX}_${coordY}`;

  if (selectedCellKey && selectedCellKey !== cellKey) {
    const previous = cellObjects.get(selectedCellKey);
    if (previous) {
      removeCellSelectionMarker(previous.group);
    }
  }

  const entry = cellObjects.get(cellKey);
  if (!entry) {
    return;
  }

  if (enabled) {
    selectedCellKey = cellKey;
    addCellSelectionMarker(entry.group);
  } else {
    if (selectedCellKey === cellKey) {
      selectedCellKey = null;
    }
    removeCellSelectionMarker(entry.group);
  }
}

export function highlightShip(shipId, enabled) {
  if (selectedShipId && selectedShipId !== shipId) {
    const previous = shipObjects.get(selectedShipId);
    if (previous) {
      removeSelectionRing(previous);
      setShipGlow(previous, false);
    }
  }

  const mesh = shipObjects.get(shipId);
  if (!mesh) {
    return;
  }

  if (enabled) {
    selectedShipId = shipId;
    setShipGlow(mesh, true);
    addSelectionRing(mesh);
  } else {
    if (selectedShipId === shipId) {
      selectedShipId = null;
    }
    setShipGlow(mesh, false);
    removeSelectionRing(mesh);
  }
}

function setShipGlow(mesh, selected) {
  mesh.traverse((child) => {
    if (child.isMesh && child.material && "emissiveIntensity" in child.material) {
      child.material.emissiveIntensity = selected ? 0.9 : 0.32;
    }
  });
}

function addSelectionRing(mesh) {
  removeSelectionRing(mesh);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.58, 0.74, 32),
    new THREE.MeshBasicMaterial({
      color: 0x57d0ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.82
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.32;
  ring.userData.isSelectionRing = true;
  mesh.add(ring);
}

function removeSelectionRing(mesh) {
  const ring = mesh.children.find((child) => child.userData.isSelectionRing);
  if (ring) {
    mesh.remove(ring);
  }
}

function findPlanetContainerById(planetId) {
  if (!planetId) {
    return null;
  }

  for (const { group } of cellObjects.values()) {
    const planetContainer = group.children.find((child) => child.userData.isPlanetContainer);
    const planetMesh = planetContainer?.children.find((child) => child.userData.isPlanet);
    if (planetMesh?.userData?.planete?.identifiant === planetId) {
      return planetContainer;
    }
  }

  return null;
}

function addPlanetSelectionRing(planetContainer) {
  removePlanetSelectionRing(planetContainer);

  const planetMesh = planetContainer.children.find((child) => child.userData.isPlanet);
  const radius = planetMesh?.geometry?.parameters?.radius || 0.5;

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius * 1.38, radius * 1.58, 40),
    new THREE.MeshBasicMaterial({
      color: 0x57d0ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9
    })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  ring.userData.isPlanetSelectionRing = true;
  planetContainer.add(ring);
}

function removePlanetSelectionRing(planetContainer) {
  const ring = planetContainer.children.find((child) => child.userData.isPlanetSelectionRing);
  if (ring) {
    planetContainer.remove(ring);
  }
}

function addCellSelectionMarker(group) {
  removeCellSelectionMarker(group);

  const marker = new THREE.Mesh(
    new THREE.PlaneGeometry(2.08, 2.08),
    new THREE.MeshBasicMaterial({
      color: 0x57d0ff,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide
    })
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.03;
  marker.userData.isCellSelectionMarker = true;
  group.add(marker);
}

function removeCellSelectionMarker(group) {
  const marker = group.children.find((child) => child.userData.isCellSelectionMarker);
  if (marker) {
    group.remove(marker);
  }
}
