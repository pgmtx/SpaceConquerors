import * as THREE from 'three'
import { scene, worldPos } from './scene.js'
import { loadShipModel } from './models.js'
import { state } from './state.js'

// ── Team color palette ────────────────────────────────────────
const TEAM_COLORS = [
  0x00ffcc, 0xff4466, 0x4488ff, 0xff8800,
  0xaa44ff, 0x00ff88, 0xff2288, 0x44ccff,
  0xffff00, 0xff6600, 0x88ff00, 0xff0088,
]
const teamColorCache = new Map()

export function getTeamColor(teamId) {
  if (!teamId) return 0x334455
  if (teamColorCache.has(teamId)) return teamColorCache.get(teamId)
  const idx = teamColorCache.size % TEAM_COLORS.length
  const color = teamId === state.teamId ? 0x00ffcc : TEAM_COLORS[(idx + 1) % TEAM_COLORS.length]
  teamColorCache.set(teamId, color)
  return color
}

// ── Biome/Planet materials ────────────────────────────────────
const BIOME_COLORS = {
  AQUATIQUE:  { color: 0x1060c0, emissive: 0x001030 },
  DESERTIQUE: { color: 0xd4884a, emissive: 0x200800 },
  VOLCANIQUE: { color: 0xcc3300, emissive: 0x330800 },
  FORESTIERE: { color: 0x1a6e28, emissive: 0x021202 },
  URBANISE:   { color: 0x607080, emissive: 0x101820 },
  GLACE:      { color: 0xa8d8f0, emissive: 0x102030 },
  BASIQUE:    { color: 0x6040a0, emissive: 0x100820 },
}

const TYPE_OVERRIDES = {
  TROU_NOIR:        { color: 0x000000, emissive: 0x110022, wireframe: false, ring: false },
  TROU_DE_VER:      { color: 0x6600aa, emissive: 0x330066, ring: true, ringColor: 0xaa44ff },
  CHAMPS_ASTEROIDES:{ color: 0x666655, emissive: 0x050503 },
  VIDE:             null,
}

// ── Scene objects registry ────────────────────────────────────
const cellObjects = new Map()   // key: "x_y" → { group, type, shipMesh }
const shipObjects = new Map()   // key: shipId → mesh

export function clearMap() {
  cellObjects.forEach(({ group }) => scene.remove(group))
  cellObjects.clear()
  shipObjects.forEach(mesh => scene.remove(mesh))
  shipObjects.clear()
}

// ── Main render function ──────────────────────────────────────
export async function renderMap(cells) {
  const keysInView = new Set()

  for (const cell of cells) {
    const key = `${cell.coord_x}_${cell.coord_y}`
    keysInView.add(key)

    const existing = cellObjects.get(key)
    const hasUpdate = !existing

    if (hasUpdate) {
      const group = new THREE.Group()
      const pos = worldPos(cell.coord_x, cell.coord_y)
      group.position.copy(pos)
      group.userData = { cell, coord_x: cell.coord_x, coord_y: cell.coord_y }

      // Cell tile
      buildCellTile(group, cell)

      // Planet
      if (cell.planete) {
        buildPlanet(group, cell.planete, cell.proprietaire?.idEquipe)
      }

      scene.add(group)
      cellObjects.set(key, { group, cell })
    } else {
      // Update ownership glow on existing tile
      updateCellTile(existing.group, cell)
      // Mettre à jour les données planète (HP, minerai, etc.)
      if (cell.planete) {
        const sphere = existing.group.children.find(c => c.userData.isPlanet)
        if (sphere) sphere.userData.planete = cell.planete
      }
      existing.cell = cell
    }

    // Ship (handled separately so it can animate)
    if (cell.vaisseau) {
      await placeShip(cell.vaisseau, cell.coord_x, cell.coord_y)
    }
  }

  // Remove cells no longer in view
  cellObjects.forEach((val, key) => {
    if (!keysInView.has(key)) {
      scene.remove(val.group)
      cellObjects.delete(key)
    }
  })
}

// ── Cell tile ─────────────────────────────────────────────────
function buildCellTile(group, cell) {
  const ownerId = cell.proprietaire?.idEquipe
  const color = ownerId ? getTeamColor(ownerId) : 0x0a1a2a
  const emissive = ownerId ? color : 0x000000

  const geo = new THREE.PlaneGeometry(1.92, 1.92)
  const mat = new THREE.MeshLambertMaterial({
    color,
    emissive,
    emissiveIntensity: ownerId ? 0.05 : 0,
    transparent: true,
    opacity: ownerId ? 0.35 : 0.15,
  })
  const tile = new THREE.Mesh(geo, mat)
  tile.rotation.x = -Math.PI / 2
  tile.position.y = -0.01
  tile.userData.isTile = true
  group.add(tile)
}

function updateCellTile(group, cell) {
  const tile = group.children.find(c => c.userData.isTile)
  if (!tile) return
  const ownerId = cell.proprietaire?.idEquipe
  const color = ownerId ? getTeamColor(ownerId) : 0x0a1a2a
  tile.material.color.setHex(color)
  tile.material.emissive.setHex(ownerId ? color : 0x000000)
  tile.material.emissiveIntensity = ownerId ? 0.05 : 0
  tile.material.opacity = ownerId ? 0.35 : 0.15
}

// ── Planet ────────────────────────────────────────────────────
function buildPlanet(group, planete, ownerId) {
  const model = planete.modelePlanete
  const typePlanete = model?.typePlanete
  const biome = model?.biome

  if (typePlanete === 'VIDE') return

  // Special types
  const typeOverride = TYPE_OVERRIDES[typePlanete]
  let colorDef = BIOME_COLORS[biome] || { color: 0x445566, emissive: 0x001122 }
  if (typeOverride) colorDef = typeOverride

  const radius = typePlanete === 'GAZEUSE' ? 0.55 : 0.42
  const geo = new THREE.SphereGeometry(radius, 24, 16)
  const mat = new THREE.MeshPhongMaterial({
    color: colorDef.color,
    emissive: colorDef.emissive || 0x000000,
    emissiveIntensity: 0.4,
    shininess: typePlanete === 'GAZEUSE' ? 30 : 15,
  })

  // Extra atmosphere for gas planets
  if (typePlanete === 'GAZEUSE') {
    const atmoGeo = new THREE.SphereGeometry(radius * 1.08, 16, 8)
    const atmoMat = new THREE.MeshLambertMaterial({
      color: colorDef.color,
      transparent: true,
      opacity: 0.15,
      side: THREE.BackSide,
    })
    group.add(new THREE.Mesh(atmoGeo, atmoMat))
  }

  // Black hole: dark sphere with ring
  if (typePlanete === 'TROU_NOIR') {
    mat.color.setHex(0x000000)
    mat.emissive.setHex(0x220033)
    mat.emissiveIntensity = 0.5
    addRing(group, radius * 1.5, radius * 2.4, 0xaa00ff, 0.5)
  }

  // Wormhole: swirling ring
  if (typePlanete === 'TROU_DE_VER') {
    addRing(group, radius * 1.3, radius * 1.8, 0xaa44ff, 0.6)
  }

  const sphere = new THREE.Mesh(geo, mat)
  sphere.position.y = radius
  sphere.castShadow = true
  sphere.userData.isPlanet = true
  sphere.userData.planete = planete

  // Owner glow ring around base
  if (ownerId) {
    const ringGeo = new THREE.RingGeometry(radius * 1.1, radius * 1.3, 32)
    const ringMat = new THREE.MeshBasicMaterial({
      color: getTeamColor(ownerId),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.6,
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.02
    group.add(ring)
  }

  // Health bar above planet
  buildHealthBar(group, planete.pointDeVie, planete.pointDeVie, radius * 2 + 0.2)

  // Modules indicators
  if (planete.modules && planete.modules.length > 0) {
    buildModuleIndicators(group, planete.modules, radius)
  }

  group.add(sphere)
}

function addRing(group, innerR, outerR, color, opacity) {
  const geo = new THREE.RingGeometry(innerR, outerR, 32)
  const mat = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    transparent: true,
    opacity,
  })
  const ring = new THREE.Mesh(geo, mat)
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.3
  group.add(ring)
}

function buildHealthBar(group, hp, maxHp, yOffset) {
  if (!hp || !maxHp) return
  const pct = Math.max(0, Math.min(1, hp / maxHp))
  const w = 1.2

  // Background
  const bgGeo = new THREE.PlaneGeometry(w, 0.1)
  const bgMat = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide })
  const bg = new THREE.Mesh(bgGeo, bgMat)
  bg.position.y = yOffset
  group.add(bg)

  // Fill
  const fillGeo = new THREE.PlaneGeometry(w * pct, 0.08)
  const fillColor = pct > 0.6 ? 0x00ff66 : pct > 0.3 ? 0xffaa00 : 0xff2244
  const fillMat = new THREE.MeshBasicMaterial({ color: fillColor, side: THREE.DoubleSide })
  const fill = new THREE.Mesh(fillGeo, fillMat)
  fill.position.x = -(w / 2) + (w * pct / 2)
  fill.position.y = yOffset
  fill.position.z = 0.01
  group.add(fill)
}

function buildModuleIndicators(group, modules, planetRadius) {
  modules.forEach((mod, i) => {
    const angle = (i / modules.length) * Math.PI * 2
    const r = planetRadius * 1.5
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1)
    const mat = new THREE.MeshBasicMaterial({ color: 0xffaa00 })
    const cube = new THREE.Mesh(geo, mat)
    cube.position.set(Math.cos(angle) * r, planetRadius * 0.8, Math.sin(angle) * r)
    group.add(cube)
  })
}

// ── Ships ─────────────────────────────────────────────────────
async function placeShip(vaisseau, x, y) {
  const shipId = vaisseau.idVaisseau
  if (shipObjects.has(shipId)) {
    // Animate to new position
    const existing = shipObjects.get(shipId)
    const target = worldPos(x, y)
    target.y = 0.5
    existing.userData.targetPos = target
    existing.userData.vaisseau = vaisseau
    return
  }

  const classe = vaisseau.type?.classeVaisseau || 'SONDE'
  let model
  try {
    model = await loadShipModel(classe)
  } catch {
    const geo = new THREE.ConeGeometry(0.2, 0.5, 6)
    const mat = new THREE.MeshPhongMaterial({ color: 0x4488ff })
    model = new THREE.Mesh(geo, mat)
  }

  const pos = worldPos(x, y)
  pos.y = 0.5
  model.position.copy(pos)
  model.userData.vaisseau = vaisseau
  model.userData.isShip = true
  model.userData.targetPos = pos.clone()

  // Owner color tint
  const ownColor = new THREE.Color(getTeamColor(vaisseau.proprietaire))
  model.traverse(child => {
    if (child.isMesh && child.material) {
      child.material = child.material.clone()
      child.material.emissive = ownColor
      child.material.emissiveIntensity = vaisseau.proprietaire === state.teamId ? 0.3 : 0.1
    }
  })

  scene.add(model)
  shipObjects.set(shipId, model)
}

// ── Animation tick (called every frame) ──────────────────────
export function animateMap(delta) {
  const t = Date.now() * 0.001

  // Animate ships toward target positions
  shipObjects.forEach((mesh) => {
    if (mesh.userData.targetPos) {
      mesh.position.lerp(mesh.userData.targetPos, 0.05)
    }
    // Gentle hover bob
    mesh.position.y = 0.5 + Math.sin(t * 1.5 + mesh.position.x) * 0.04
    // Slow rotation
    mesh.rotation.y += delta * 0.3
  })

  // Animate planets (slow rotation)
  cellObjects.forEach(({ group }) => {
    const sphere = group.children.find(c => c.userData.isPlanet)
    if (sphere) {
      sphere.rotation.y += delta * 0.2
    }
  })
}

// ── Raycasting / selection ────────────────────────────────────
export function getClickedObject(raycaster) {
  // Ships first
  const shipMeshes = []
  shipObjects.forEach(mesh => {
    mesh.traverse(c => { if (c.isMesh) shipMeshes.push(c) })
  })
  let hits = raycaster.intersectObjects(shipMeshes, false)
  if (hits.length > 0) {
    let obj = hits[0].object
    while (obj && !obj.userData.isShip) obj = obj.parent
    return obj ? { type: 'ship', data: obj.userData.vaisseau } : null
  }

  // Planets
  const planetMeshes = []
  cellObjects.forEach(({ group }) => {
    group.children.forEach(c => { if (c.userData.isPlanet) planetMeshes.push(c) })
  })
  hits = raycaster.intersectObjects(planetMeshes, false)
  if (hits.length > 0) {
    return { type: 'planet', data: hits[0].object.userData.planete }
  }

  // Tiles
  const tiles = []
  cellObjects.forEach(({ group }) => {
    group.children.forEach(c => { if (c.userData.isTile) tiles.push(c) })
  })
  hits = raycaster.intersectObjects(tiles, false)
  if (hits.length > 0) {
    const g = hits[0].object.parent
    return { type: 'cell', data: g.userData.cell }
  }

  return null
}

export function highlightShip(shipId, on) {
  const mesh = shipObjects.get(shipId)
  if (!mesh) return
  mesh.traverse(child => {
    if (child.isMesh && child.material) {
      child.material.emissiveIntensity = on ? 0.8 : 0.3
    }
  })
}
