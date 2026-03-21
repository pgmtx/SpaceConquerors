import { state } from './state.js'
import { getTeamColor } from './mapRenderer.js'
import {
  doAction, placeModule, removeModule,
  renameShip, buildShip, getPlans,
  getMarketOffers, buyOffer, createOffer, deleteOffer,
  getModules,
} from './api.js'

// ── Helpers ────────────────────────────────────────────────────
function fmt(n) {
  if (n === undefined || n === null) return '?'
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function isShipAvailable(vaisseau) {
  if (!vaisseau.dateProchaineAction) return true
  return new Date(vaisseau.dateProchaineAction) <= new Date()
}

// ── Notifications ──────────────────────────────────────────────
export function notify(msg, type = 'info') {
  const container = document.getElementById('notifications')
  const el = document.createElement('div')
  el.className = `notif${type !== 'info' ? ' ' + type : ''}`
  el.textContent = msg
  container.appendChild(el)
  setTimeout(() => el.remove(), 3500)
}

// ── Loading progress ───────────────────────────────────────────
export function setLoading(pct, status) {
  document.getElementById('loading-bar-fill').style.width = `${pct}%`
  if (status) document.getElementById('loading-status').textContent = status
}

export function hideLoading() {
  const el = document.getElementById('loading')
  el.style.transition = 'opacity 0.6s'
  el.style.opacity = '0'
  setTimeout(() => el.remove(), 700)
}

// ── Coordinates display ────────────────────────────────────────
export function updateCoords(x, y) {
  document.getElementById('coords-display').textContent = `[ X:${x} Y:${y} ]`
}

// ── HUD resources & team stats ─────────────────────────────────
export function updateHUD(team) {
  if (!team) return

  const resources = team.ressources || []
  const minerai = resources.find(r => r.ressource?.nom === 'MINERAI')?.quantite ?? 0
  const credits  = resources.find(r => r.ressource?.nom === 'CREDIT')?.quantite ?? 0
  const ships    = resources.find(r => r.ressource?.nom === 'VAISSEAU')?.quantite ?? 0
  const points   = resources.find(r => r.ressource?.nom === 'POINT')?.quantite ?? 0

  document.getElementById('res-minerai').textContent = fmt(minerai)
  document.getElementById('res-credits').textContent  = fmt(credits)
  document.getElementById('res-ships').textContent    = fmt(ships)
  document.getElementById('team-score-val').textContent = fmt(points)
}

// ── Leaderboard ────────────────────────────────────────────────
export function updateLeaderboard(teams) {
  const list = document.getElementById('leaderboard-list')
  list.innerHTML = ''

  const sorted = [...teams].sort((a, b) => {
    const pa = getPoints(a), pb = getPoints(b)
    return pb - pa
  })

  sorted.slice(0, 16).forEach((team, i) => {
    const pts = getPoints(team)
    const isMe = team.idEquipe === state.teamId
    const color = '#' + getTeamColor(team.idEquipe).toString(16).padStart(6, '0')

    const row = document.createElement('div')
    row.className = `lb-row${isMe ? ' my-team' : ''}`
    row.innerHTML = `
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-color" style="background:${color}"></span>
      <span class="lb-name" title="${team.nom}">${team.nom}</span>
      <span class="lb-pts">${fmt(pts)}</span>
    `
    list.appendChild(row)
  })
}

function getPoints(team) {
  return (team.ressources || []).find(r => r.ressource?.nom === 'POINT')?.quantite ?? 0
}

// ── Bottom bar portrait helpers ────────────────────────────────
function setPortrait(icon, name, subtitle, hpPct) {
  document.getElementById('portrait-icon').textContent = icon
  document.getElementById('portrait-name').textContent = name || '---'
  document.getElementById('portrait-subtitle').textContent = subtitle || ''

  const fill = document.getElementById('portrait-hp-fill')
  if (hpPct !== null && hpPct !== undefined) {
    fill.style.width = `${Math.max(0, Math.min(100, hpPct * 100))}%`
    fill.style.background = hpPct > 0.6 ? '#00ff66' : hpPct > 0.3 ? '#ffaa00' : '#ff3344'
    document.getElementById('portrait-hp-bar').style.display = 'block'
  } else {
    document.getElementById('portrait-hp-bar').style.display = 'none'
    fill.style.width = '100%'
  }
}

function setStats(rows) {
  // rows: [{key, val, cls}]
  const container = document.getElementById('stats-content')
  container.innerHTML = rows.map(r => `
    <div class="stat-row">
      <span class="stat-key">${r.key}</span>
      <span class="stat-val${r.cls ? ' ' + r.cls : ''}">${r.val}</span>
    </div>
  `).join('')
}

function buildCommandCard(buttons) {
  // buttons: [{icon, label, action, disabled, active}] — up to 12 slots in 4x3
  const card = document.getElementById('command-card')
  card.innerHTML = ''
  const total = 12
  for (let i = 0; i < total; i++) {
    const btn = buttons[i]
    if (!btn) {
      const spacer = document.createElement('div')
      spacer.className = 'cmd-btn spacer'
      card.appendChild(spacer)
      continue
    }
    const el = document.createElement('button')
    el.className = 'cmd-btn' + (btn.active ? ' active-action' : '')
    el.disabled = !!btn.disabled
    el.innerHTML = `${btn.icon}<div class="cmd-label">${btn.label}</div>`
    el.title = btn.tooltip || btn.label
    if (btn.action) el.addEventListener('click', btn.action)
    card.appendChild(el)
  }
}

// ── Ship info ──────────────────────────────────────────────────
export function showShipInfo(vaisseau) {
  if (!vaisseau) return closeInfoPanel()

  const hp = vaisseau.pointDeVie ?? 0
  const maxHp = vaisseau.type?.pointDeVie ?? 1
  const hpPct = maxHp > 0 ? hp / maxHp : 0
  const cargo = vaisseau.mineraiTransporte ?? 0
  const capCargo = vaisseau.type?.capaciteTransport ?? 0
  const isAvailable = isShipAvailable(vaisseau)
  const isOurs = vaisseau.proprietaire === state.teamId
  const classe = vaisseau.type?.classeVaisseau || vaisseau.type?.nom || 'VAISSEAU'

  setPortrait('🚀', vaisseau.nom, classe, hpPct)

  const hpCls = hpPct > 0.6 ? 'good' : hpPct > 0.3 ? 'warn' : 'bad'
  setStats([
    { key: 'HP',      val: `${hp} / ${maxHp}`, cls: hpCls },
    { key: 'ATK',     val: vaisseau.type?.attaque ?? '?' },
    { key: 'POS',     val: `(${vaisseau.positionX ?? '?'}, ${vaisseau.positionY ?? '?'})` },
    { key: 'CARGO',   val: `${cargo} / ${capCargo}` },
    { key: 'STATUS',  val: isAvailable ? 'PRÊT' : 'COOLDOWN', cls: isAvailable ? 'good' : 'bad' },
  ])

  if (isOurs) {
    const disabled = !isAvailable
    buildCommandCard([
      { icon: '🏃', label: 'DÉPLACER', disabled, active: state.pendingAction?.action === 'DEPLACEMENT',
        action: () => setPendingAction({ action: 'DEPLACEMENT', vaisseau }) },
      { icon: '⛏',  label: 'RÉCOLTER', disabled, active: state.pendingAction?.action === 'RECOLTER',
        action: () => setPendingAction({ action: 'RECOLTER', vaisseau }) },
      { icon: '📦', label: 'DÉPOSER',  disabled, active: state.pendingAction?.action === 'DEPOSER',
        action: () => setPendingAction({ action: 'DEPOSER', vaisseau }) },
      { icon: '⚔',  label: 'ATTAQUER', disabled, active: state.pendingAction?.action === 'ATTAQUER',
        action: () => setPendingAction({ action: 'ATTAQUER', vaisseau }) },
      { icon: '🏴', label: 'CONQUÉRIR', disabled, active: state.pendingAction?.action === 'CONQUERIR',
        action: () => setPendingAction({ action: 'CONQUERIR', vaisseau }) },
      { icon: '🔧', label: 'RÉPARER',  disabled, active: state.pendingAction?.action === 'REPARER',
        action: () => setPendingAction({ action: 'REPARER', vaisseau }) },
      { icon: '✏',  label: 'RENOMMER', disabled: false,
        action: () => openRenameModal(vaisseau) },
      null, null, null, null, null,
    ])
  } else {
    buildCommandCard([])
  }
}

// ── Planet info ────────────────────────────────────────────────
let _lastPlanete = null

export function refreshSelectedPlanet(mapCells) {
  if (!_lastPlanete) return
  const cell = mapCells.find(c => c.planete?.idPlanete === _lastPlanete.idPlanete)
  if (cell?.planete) showPlanetInfo(cell.planete)
}

export function showPlanetInfo(planete) {
  if (!planete) return closeInfoPanel()
  _lastPlanete = planete

  const biome = planete.modelePlanete?.biome || '--'
  const type  = planete.modelePlanete?.typePlanete || '--'
  const hp    = planete.pointDeVie ?? 0
  const minerai = planete.mineraiDisponible ?? 0
  const slots   = planete.slotsConstruction ?? 0
  const mods    = (planete.modules || []).length
  const hpPct   = hp / 100
  const hpCls   = hpPct > 0.6 ? 'good' : hpPct > 0.3 ? 'warn' : 'bad'

  setPortrait('🌍', planete.nom, `${type} · ${biome}`, hpPct)

  setStats([
    { key: 'HP',      val: String(hp),          cls: hpCls },
    { key: 'MINERAI', val: fmt(minerai) },
    { key: 'SLOTS',   val: `${mods} / ${slots}` },
    { key: 'MODULES', val: String(mods) },
  ])

  const isOurs = planete.proprietaire?.idEquipe === state.teamId ||
                 planete.proprietaire === state.teamId

  if (isOurs) {
    // Show modules inline in stats area instead of command card
    renderModulesInStats(planete)

    buildCommandCard([
      { icon: '◈', label: 'MODULES',   action: () => renderModulesInStats(planete) },
      { icon: '🔨', label: 'CONSTRUIRE', action: () => openShipBuilder(planete) },
      null, null, null, null, null, null, null, null, null, null,
    ])
  } else {
    buildCommandCard([])
  }
}

function renderModulesInStats(planete) {
  const container = document.getElementById('stats-content')
  container.innerHTML = ''

  const placed = planete.modules || []
  const available = (state.myTeam?.modules || []).filter(m => !m.idPlanete)

  if (placed.length === 0 && available.length === 0) {
    container.innerHTML = '<div style="color:#334466;font-size:10px;letter-spacing:1px;padding:6px 0;">AUCUN MODULE</div>'
    return
  }

  placed.forEach(mod => {
    const typeLabel = mod.paramModule?.typeModule || '?'
    const row = document.createElement('div')
    row.className = 'stat-row'
    row.style.cssText = 'cursor:pointer'
    row.innerHTML = `
      <span class="stat-key" style="color:#ffaa44">◈ ${typeLabel}</span>
      <span class="stat-val bad" style="cursor:pointer" title="Retirer">✕</span>
    `
    row.querySelector('.stat-val').addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        await removeModule(state.teamId, mod.id)
        notify(`Module ${typeLabel} retiré`, 'success')
        // Refresh modules in state
        const mods = await getModules(state.teamId)
        if (state.myTeam) state.myTeam.modules = mods
      } catch (err) { notify(err.message, 'error') }
    })
    container.appendChild(row)
  })

  available.forEach(mod => {
    const typeLabel = mod.paramModule?.typeModule || '?'
    const row = document.createElement('div')
    row.className = 'stat-row'
    row.style.cssText = 'cursor:pointer'
    row.innerHTML = `
      <span class="stat-key" style="color:#88aacc">+ ${typeLabel}</span>
      <span class="stat-val good" style="cursor:pointer" title="Poser">▶</span>
    `
    row.querySelector('.stat-val').addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        await placeModule(state.teamId, mod.id, planete.idPlanete)
        notify(`Module ${typeLabel} posé !`, 'success')
        const mods = await getModules(state.teamId)
        if (state.myTeam) state.myTeam.modules = mods
      } catch (err) { notify(err.message, 'error') }
    })
    container.appendChild(row)
  })
}

// ── Close selection ────────────────────────────────────────────
export function closeInfoPanel() {
  _lastPlanete = null
  state.selectedShip = null
  state.selectedPlanet = null
  clearPendingAction()

  setPortrait('◈', '---', 'AUCUNE SÉLECTION', null)
  document.getElementById('stats-content').innerHTML = ''
  buildCommandCard([])
}

// ── Minimap ────────────────────────────────────────────────────
let minimapCtx = null

export function initMinimap() {
  const canvas = document.getElementById('minimap')
  minimapCtx = canvas.getContext('2d')
  canvas.addEventListener('click', onMinimapClick)
}

export function drawMinimap(cells, _allTeamsData) {
  if (!minimapCtx) return
  const canvas = minimapCtx.canvas
  const W = canvas.width, H = canvas.height
  const GRID = 58

  minimapCtx.clearRect(0, 0, W, H)
  minimapCtx.fillStyle = '#01080f'
  minimapCtx.fillRect(0, 0, W, H)

  const cw = W / GRID, ch = H / GRID

  // Draw planets from state.minimapPlanets
  state.minimapPlanets.forEach(({ x, y, ownerId }) => {
    const px = x * cw, py = y * ch
    const color = ownerId ? '#' + getTeamColor(ownerId).toString(16).padStart(6, '0') : '#1a2a3a'
    minimapCtx.fillStyle = color
    minimapCtx.fillRect(px, py, Math.max(2, cw), Math.max(2, ch))
  })

  // Draw ships from visible cells
  cells.forEach(cell => {
    if (!cell.vaisseau) return
    const px = cell.coord_x * cw, py = cell.coord_y * ch
    const color = '#' + getTeamColor(cell.vaisseau.proprietaire).toString(16).padStart(6, '0')
    minimapCtx.fillStyle = color
    minimapCtx.beginPath()
    minimapCtx.arc(px + cw / 2, py + ch / 2, 2, 0, Math.PI * 2)
    minimapCtx.fill()
  })

  // Viewport indicator
  const vx = state.viewX * cw, vy = state.viewY * ch
  const vw = state.viewSize * cw, vh = state.viewSize * ch
  minimapCtx.strokeStyle = 'rgba(0,200,255,0.8)'
  minimapCtx.lineWidth = 1
  minimapCtx.strokeRect(vx, vy, vw, vh)
}

function onMinimapClick(e) {
  const canvas = e.target
  const rect = canvas.getBoundingClientRect()
  const fx = (e.clientX - rect.left) / canvas.width
  const fy = (e.clientY - rect.top)  / canvas.height
  const gx = Math.floor(fx * 58)
  const gy = Math.floor(fy * 58)
  const newX = Math.max(0, Math.min(58 - state.viewSize, gx - Math.floor(state.viewSize / 2)))
  const newY = Math.max(0, Math.min(58 - state.viewSize, gy - Math.floor(state.viewSize / 2)))
  state.viewX = newX
  state.viewY = newY
}

// ── Pending action crosshair ───────────────────────────────────
export function setPendingAction(pending) {
  state.pendingAction = pending

  // Update command card button active states
  if (state.selectedShip) showShipInfo(state.selectedShip)

  const indicator = document.getElementById('crosshair-indicator')
  indicator.classList.add('visible')
  document.getElementById('crosshair-label').textContent =
    `CIBLE POUR : ${pending.action}`
  notify(`Cliquez sur la cible — ${pending.action}`, 'info')
}

export function clearPendingAction() {
  state.pendingAction = null
  document.getElementById('crosshair-indicator').classList.remove('visible')
}

export async function executePendingAction(coord_x, coord_y) {
  const pending = state.pendingAction
  if (!pending) return false
  clearPendingAction()

  try {
    await doAction(state.teamId, pending.vaisseau.idVaisseau, pending.action, coord_x, coord_y)
    notify(`${pending.action} → (${coord_x},${coord_y}) ✓`, 'success')
  } catch (e) {
    notify(e.message, 'error')
  }
  return true
}

// ── Market modal ───────────────────────────────────────────────
export async function openMarket() {
  const modal = document.getElementById('market-modal')
  modal.classList.remove('hidden')

  const listEl  = document.getElementById('market-list')
  const loadEl  = document.getElementById('market-loading')
  listEl.innerHTML = ''
  loadEl.style.display = 'block'

  // Populate sell module dropdown
  const sellSelect = document.getElementById('sell-module-select')
  sellSelect.innerHTML = '<option value="">-- Sélectionner un module --</option>'
  const availMods = (state.myTeam?.modules || []).filter(m => !m.idPlanete)
  availMods.forEach(mod => {
    const opt = document.createElement('option')
    opt.value = mod.id
    opt.textContent = mod.paramModule?.typeModule || mod.id
    sellSelect.appendChild(opt)
  })

  try {
    const offers = await getMarketOffers()
    loadEl.style.display = 'none'
    listEl.innerHTML = ''

    if (!offers || offers.length === 0) {
      listEl.innerHTML = '<div style="color:#334466;font-size:11px;padding:12px 0;letter-spacing:2px;text-align:center;">AUCUNE OFFRE</div>'
      return
    }

    offers.forEach(offer => {
      const row = document.createElement('div')
      row.className = 'market-offer'
      const typeLabel = offer.module?.paramModule?.typeModule || '?'
      const statusCls = offer.statut || 'DISPONIBLE'
      const isOwnOffer = offer.idVendeur === state.teamId
      const canBuy = !isOwnOffer && statusCls === 'DISPONIBLE'

      row.innerHTML = `
        <span class="offer-type">◈ ${typeLabel}</span>
        <span class="offer-seller">${isOwnOffer ? '[ VOUS ]' : (offer.idVendeur || '?').substring(0, 8) + '...'}</span>
        <span class="offer-price">${fmt(offer.prixVente)} cr</span>
        <span class="offer-status ${statusCls}">${statusCls}</span>
        ${canBuy ? `<button class="btn-buy" data-id="${offer.idOffre}">ACHETER</button>` : ''}
        ${isOwnOffer && statusCls === 'DISPONIBLE' ? `<button class="btn-buy" data-id="${offer.idOffre}" data-cancel="1" style="color:#ff4466;border-color:rgba(255,50,70,0.4)">ANNULER</button>` : ''}
      `

      const buyBtn = row.querySelector('.btn-buy')
      if (buyBtn) {
        buyBtn.addEventListener('click', async () => {
          buyBtn.disabled = true
          try {
            if (buyBtn.dataset.cancel) {
              await deleteOffer(offer.idOffre)
              notify('Offre annulée', 'success')
            } else {
              await buyOffer(offer.idOffre)
              notify(`Module ${typeLabel} acheté !`, 'success')
            }
            await openMarket() // refresh
          } catch (e) {
            notify(e.message, 'error')
            buyBtn.disabled = false
          }
        })
      }
      listEl.appendChild(row)
    })
  } catch (e) {
    loadEl.style.display = 'none'
    notify('Erreur marché: ' + e.message, 'error')
  }

  // Sell confirm button
  const sellBtn = document.getElementById('sell-confirm-btn')
  const newSellBtn = sellBtn.cloneNode(true)
  sellBtn.parentNode.replaceChild(newSellBtn, sellBtn)
  newSellBtn.addEventListener('click', async () => {
    const modId = document.getElementById('sell-module-select').value
    const price = parseInt(document.getElementById('sell-price-input').value, 10)
    if (!modId) { notify('Sélectionnez un module', 'error'); return }
    if (!price || price < 1) { notify('Prix invalide', 'error'); return }
    newSellBtn.disabled = true
    try {
      await createOffer({ idModule: modId, prixVente: price })
      notify('Offre créée !', 'success')
      document.getElementById('sell-price-input').value = ''
      document.getElementById('sell-module-select').value = ''
      await openMarket()
    } catch (e) {
      notify(e.message, 'error')
      newSellBtn.disabled = false
    }
  })
}

// ── Ship builder modal ─────────────────────────────────────────
let _builderPlanete = null
let _selectedPlanId = null

export async function openShipBuilder(planete) {
  _builderPlanete = planete
  _selectedPlanId = null

  const modal = document.getElementById('builder-modal')
  modal.classList.remove('hidden')
  document.getElementById('builder-planet-label').textContent =
    `PLANÈTE: ${planete.nom || '?'}`

  const listEl = document.getElementById('builder-list')
  listEl.innerHTML = '<div style="color:#334466;font-size:11px;padding:12px 0;letter-spacing:2px;text-align:center;">CHARGEMENT...</div>'

  try {
    const plans = await getPlans(state.teamId)
    listEl.innerHTML = ''

    if (!plans || plans.length === 0) {
      listEl.innerHTML = '<div style="color:#334466;font-size:11px;padding:12px 0;text-align:center;">AUCUN PLAN DISPONIBLE</div>'
      return
    }

    plans.forEach(plan => {
      const row = document.createElement('div')
      row.className = 'plan-row'
      row.dataset.planId = plan.id
      const tv = plan.typeVaisseau || {}
      row.innerHTML = `
        <span class="plan-name">${plan.nom || tv.classeVaisseau || '?'}</span>
        <div class="plan-stats">
          <span>ATK <span>${tv.attaque ?? '?'}</span></span>
          <span>HP <span>${tv.pointDeVie ?? '?'}</span></span>
          <span>CARGO <span>${tv.capaciteTransport ?? '?'}</span></span>
          <span>COÛT <span style="color:#ffcc44">${fmt(tv.coutConstruction ?? 0)}</span></span>
        </div>
      `
      row.addEventListener('click', () => {
        listEl.querySelectorAll('.plan-row').forEach(r => r.classList.remove('selected'))
        row.classList.add('selected')
        _selectedPlanId = plan.id
      })
      listEl.appendChild(row)
    })
  } catch (e) {
    listEl.innerHTML = ''
    notify('Erreur plans: ' + e.message, 'error')
  }

  // Confirm button
  const confirmBtn = document.getElementById('builder-confirm')
  const newConfirmBtn = confirmBtn.cloneNode(true)
  confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn)
  newConfirmBtn.addEventListener('click', async () => {
    if (!_selectedPlanId) { notify('Sélectionnez un plan', 'error'); return }
    newConfirmBtn.disabled = true
    try {
      await buildShip(state.teamId, { idTypePlanVaisseau: _selectedPlanId })
      notify('Vaisseau en construction !', 'success')
      document.getElementById('builder-modal').classList.add('hidden')
    } catch (e) {
      notify(e.message, 'error')
      newConfirmBtn.disabled = false
    }
  })
}

// ── Rename modal ───────────────────────────────────────────────
function openRenameModal(vaisseau) {
  const modal = document.getElementById('rename-modal')
  modal.classList.remove('hidden')
  const input = document.getElementById('rename-input')
  input.value = vaisseau.nom || ''
  input.focus()
  input.select()

  const confirmBtn = document.getElementById('rename-confirm')
  const newBtn = confirmBtn.cloneNode(true)
  confirmBtn.parentNode.replaceChild(newBtn, confirmBtn)

  const doRename = async () => {
    const nom = input.value.trim()
    if (!nom) { notify('Nom invalide', 'error'); return }
    newBtn.disabled = true
    try {
      await renameShip(state.teamId, vaisseau.idVaisseau, nom)
      notify(`Vaisseau renommé : ${nom}`, 'success')
      vaisseau.nom = nom
      showShipInfo(vaisseau)
      modal.classList.add('hidden')
    } catch (e) {
      notify(e.message, 'error')
      newBtn.disabled = false
    }
  }

  newBtn.addEventListener('click', doRename)
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doRename() })
}
