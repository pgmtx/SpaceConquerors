import * as THREE from 'three'
import { initScene, scene, camera, controls, render, worldPos, panCameraTo, focusOnShip } from './scene.js'
import { renderMap, animateMap, getClickedObject, highlightShip, clearMap } from './mapRenderer.js'
import {
  setLoading, hideLoading, notify, updateCoords,
  updateTeamHUD, updateLeaderboard, showShipInfo, showPlanetInfo,
  closeInfoPanel, initMinimap, drawMinimap, executePendingAction,
} from './ui.js'
import { getTeamIdFromToken, getMap, getAllTeams, getShips, getModules } from './api.js'
import { preloadAllModels } from './models.js'
import { state } from './state.js'

// ── Bootstrap ─────────────────────────────────────────────────
async function main() {
  setLoading(5, 'CONNEXION AU SERVEUR...')

  // Récupérer le token depuis le serveur proxy pour décoder le team_id
  const tokenRes = await fetch('/token').then(r => r.json()).catch(() => null)
  const token = tokenRes?.access_token || ''
  if (!token) {
    setLoading(0, 'ERREUR: impossible de récupérer le token depuis le serveur')
    return
  }
  state.token = token
  state.teamId = getTeamIdFromToken(token)

  setLoading(15, 'CHARGEMENT DES MODÈLES 3D...')

  // Init Three.js scene
  const container = document.getElementById('canvas-container')
  initScene(container)

  // Pre-load 3D models
  await preloadAllModels((loaded, total) => {
    setLoading(15 + (loaded / total) * 40, `MODÈLES 3D: ${loaded}/${total}`)
  })

  setLoading(60, 'RÉCUPÉRATION DE LA CARTE...')

  // Init minimap
  initMinimap()

  // Initial data load (2 requests total)
  await Promise.allSettled([refreshMap(), refreshAllTeams()])

  setLoading(95, 'PRÊT')
  await new Promise(r => setTimeout(r, 400))
  hideLoading()

  // Start game loop
  startGameLoop()
  registerInput()
  registerRefreshButton()
}

// ── Game loop ─────────────────────────────────────────────────
function startGameLoop() {
  let lastTime = 0
  function loop(time) {
    const delta = (time - lastTime) / 1000
    lastTime = time

    handleKeyMovement(delta)
    animateMap(delta)
    render(delta)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}

// ── Data fetchers (2 requests per manual refresh) ────────────
async function refreshMap() {
  const { viewX, viewY, viewSize } = state
  try {
    const cells = await getMap(viewX, viewX + viewSize - 1, viewY, viewY + viewSize - 1)
    state.mapCells = cells || []
    updateMinimapData(state.mapCells)
    await renderMap(state.mapCells)
    updateCoords(viewX, viewY)
    drawMinimap(state.mapCells, state.allTeams)
  } catch (e) {
    console.error('Map error:', e)
    notify('Erreur carte: ' + e.message, 'error')
  }
}

async function refreshAllTeams() {
  try {
    const [teams, myShips, myModules] = await Promise.all([
      getAllTeams(),
      getShips(state.teamId),
      getModules(state.teamId),
    ])
    state.allTeams = teams || []
    state.myTeam = state.allTeams.find(t => t.idEquipe === state.teamId) || null
    if (state.myTeam) {
      // positionX/Y absents de /equipes, forcer proprietaire pour les boutons
      if (myShips) state.myTeam.vaisseaux = myShips.map(s => ({ ...s, proprietaire: state.teamId }))
      // modules avec idPlanete null = disponibles à poser
      if (myModules) state.myTeam.modules = myModules
    }
    updateTeamHUD(state.myTeam)
    updateLeaderboard(state.allTeams)
  } catch (e) {
    console.error('Teams error:', e)
    notify('Erreur équipes: ' + e.message, 'error')
  }
}

// ── Manual refresh button ─────────────────────────────────────
function registerRefreshButton() {
  const btn = document.getElementById('refresh-btn')
  btn.addEventListener('click', async () => {
    if (btn.disabled) return
    btn.disabled = true
    btn.textContent = '⟳ ...'
    // 2 requests in parallel
    await Promise.allSettled([refreshMap(), refreshAllTeams()])
    const now = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    btn.textContent = `⟳ ${now}`
    btn.disabled = false
  })
}

function updateMinimapData(cells) {
  cells.forEach(cell => {
    if (!cell.planete) return
    const key = `${cell.coord_x}_${cell.coord_y}`
    const existing = state.minimapPlanets.findIndex(p => p.key === key)
    const entry = {
      key,
      x: cell.coord_x,
      y: cell.coord_y,
      ownerId: cell.proprietaire?.idEquipe || null,
      type: cell.planete.modelePlanete?.typePlanete,
    }
    if (existing === -1) state.minimapPlanets.push(entry)
    else state.minimapPlanets[existing] = entry
  })
}

// ── Input ─────────────────────────────────────────────────────
const keys = {}
let shipSelectIndex = 0

function selectShipByIndex(index) {
  const ships = state.myTeam?.vaisseaux
  if (!ships || ships.length === 0) { notify('Aucun vaisseau disponible', 'error'); return }
  shipSelectIndex = ((index % ships.length) + ships.length) % ships.length
  const vaisseau = ships[shipSelectIndex]
  state.selectedShip = vaisseau
  state.selectedPlanet = null
  showShipInfo(vaisseau)
  if (vaisseau.idVaisseau) highlightShip(vaisseau.idVaisseau, true)
  if (vaisseau.positionX !== undefined) {
    const newX = Math.max(0, Math.min(58 - state.viewSize, vaisseau.positionX - Math.floor(state.viewSize / 2)))
    const newY = Math.max(0, Math.min(58 - state.viewSize, vaisseau.positionY - Math.floor(state.viewSize / 2)))
    state.viewX = newX
    state.viewY = newY
    focusOnShip(vaisseau.positionX, vaisseau.positionY)
    scheduleMapRefresh()
  }
  notify(`Vaisseau ${shipSelectIndex + 1}/${ships.length} : ${vaisseau.nom}`, 'info')
}

function registerInput() {
  window.addEventListener('keydown', e => {
    keys[e.key] = true
    if (e.key === 'Escape') {
      closeInfoPanel()
      state.pendingAction = null
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      selectShipByIndex(e.shiftKey ? shipSelectIndex - 1 : shipSelectIndex + 1)
    }
  })
  window.addEventListener('keyup', e => { keys[e.key] = false })

  // Click to select
  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()
  let lastClick = 0

  document.getElementById('canvas-container').addEventListener('click', async (e) => {
    // Debounce
    const now = Date.now()
    if (now - lastClick < 200) return
    lastClick = now

    mouse.x = (e.clientX / window.innerWidth) * 2 - 1
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1
    raycaster.setFromCamera(mouse, camera)

    const hit = getClickedObject(raycaster)
    if (!hit) {
      closeInfoPanel()
      return
    }

    // If there's a pending action, consume this click as coords
    if (state.pendingAction) {
      let cx, cy
      if (hit.type === 'cell') { cx = hit.data?.coord_x; cy = hit.data?.coord_y }
      else if (hit.type === 'planet') { cx = hit.data?.coord_x; cy = hit.data?.coord_y }
      else if (hit.type === 'ship') { cx = hit.data?.positionX; cy = hit.data?.positionY }
      if (cx !== undefined) {
        await executePendingAction(cx, cy)
        return
      }
    }

    if (hit.type === 'ship') {
      state.selectedShip = hit.data
      state.selectedPlanet = null
      showShipInfo(hit.data)
      if (state.selectedShip?.idVaisseau) highlightShip(state.selectedShip.idVaisseau, true)
    } else if (hit.type === 'planet') {
      state.selectedPlanet = hit.data
      state.selectedShip = null
      showPlanetInfo(hit.data)
    } else {
      closeInfoPanel()
    }
  })

  // Close info panel button
  document.getElementById('info-close').addEventListener('click', closeInfoPanel)
}

// ── Keyboard map movement ─────────────────────────────────────
let moveAccum = { x: 0, y: 0 }

function handleKeyMovement(delta) {
  const speed = 8 * delta

  if (keys['ArrowLeft']  || keys['a'] || keys['A']) moveAccum.x -= speed
  if (keys['ArrowRight'] || keys['d'] || keys['D']) moveAccum.x += speed
  if (keys['ArrowUp']    || keys['w'] || keys['W']) moveAccum.y -= speed
  if (keys['ArrowDown']  || keys['s'] || keys['S']) moveAccum.y += speed

  // Shift viewport by whole cells
  if (Math.abs(moveAccum.x) >= 1) {
    const step = Math.sign(moveAccum.x) * Math.floor(Math.abs(moveAccum.x))
    state.viewX = Math.max(0, Math.min(58 - state.viewSize, state.viewX + step))
    moveAccum.x -= step
    panCameraTo(state.viewX, state.viewY)
    scheduleMapRefresh()
  }
  if (Math.abs(moveAccum.y) >= 1) {
    const step = Math.sign(moveAccum.y) * Math.floor(Math.abs(moveAccum.y))
    state.viewY = Math.max(0, Math.min(58 - state.viewSize, state.viewY + step))
    moveAccum.y -= step
    panCameraTo(state.viewX, state.viewY)
    scheduleMapRefresh()
  }
}

let moveRefreshTimeout = null
function scheduleMapRefresh() {
  clearTimeout(moveRefreshTimeout)
  // Only refresh the map (1 request) when navigating — team data unchanged
  moveRefreshTimeout = setTimeout(async () => {
    clearMap()
    await refreshMap()
  }, 250)
}

main().catch(console.error)
