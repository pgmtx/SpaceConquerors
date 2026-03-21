import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

export let renderer, scene, camera, controls, clock

const CELL = 2 // world units per cell

export function initScene(container) {
  clock = new THREE.Clock()

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.1
  container.appendChild(renderer.domElement)

  // Scene
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x020810)
  scene.fog = new THREE.FogExp2(0x010510, 0.006)

  // Camera — SC2 style perspective angle
  camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 500)
  camera.position.set(20, 28, 20)
  camera.lookAt(18, 0, 18)

  // Controls
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = 8
  controls.maxDistance = 60
  controls.maxPolarAngle = Math.PI / 2.2
  controls.screenSpacePanning = true

  // Lights — cold blue/SC2 aesthetic
  const ambient = new THREE.AmbientLight(0x0d1a2e, 0.7)
  scene.add(ambient)

  const sun = new THREE.DirectionalLight(0x6688cc, 1.4)
  sun.position.set(40, 60, 30)
  sun.castShadow = true
  sun.shadow.camera.near = 10
  sun.shadow.camera.far = 200
  sun.shadow.camera.left = -40
  sun.shadow.camera.right = 40
  sun.shadow.camera.top = 40
  sun.shadow.camera.bottom = -40
  sun.shadow.mapSize.set(2048, 2048)
  scene.add(sun)

  const rimLight = new THREE.DirectionalLight(0x001844, 0.5)
  rimLight.position.set(-20, 10, -20)
  scene.add(rimLight)

  // Starfield
  buildStarfield()

  // Nebula background
  buildNebula()

  // Grid base plane
  buildGridPlane()

  // Resize handler — account for bottom bar (180px) and top bar (40px)
  window.addEventListener('resize', () => {
    const w = container.clientWidth
    const h = container.clientHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
  })

  return { renderer, scene, camera, controls }
}

function buildStarfield() {
  const count = 5000
  const positions = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const r = 200 + Math.random() * 120
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
    positions[i * 3 + 2] = r * Math.cos(phi)
    sizes[i] = Math.random() > 0.93 ? 2.2 : 0.9
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1))

  const mat = new THREE.PointsMaterial({
    color: 0xddeeff,
    size: 0.7,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
  })
  scene.add(new THREE.Points(geo, mat))
}

function buildNebula() {
  // Distant cold blue/purple dust clouds — SC2 feel
  const nebulaColors = [0x0a0033, 0x001044, 0x002211, 0x001133]
  for (let n = 0; n < 4; n++) {
    const count = 350
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 350
      positions[i * 3 + 1] = (Math.random() - 0.5) * 120 - 10
      positions[i * 3 + 2] = (Math.random() - 0.5) * 350
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      color: nebulaColors[n],
      size: 5,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.12,
    })
    scene.add(new THREE.Points(geo, mat))
  }
}

function buildGridPlane() {
  // Dark floor — SC2 dark terrain
  const geo = new THREE.PlaneGeometry(240, 240)
  const mat = new THREE.MeshLambertMaterial({
    color: 0x020810,
    transparent: true,
    opacity: 0.97,
  })
  const plane = new THREE.Mesh(geo, mat)
  plane.rotation.x = -Math.PI / 2
  plane.position.set(58, -0.05, 58)
  plane.receiveShadow = true
  scene.add(plane)

  // Grid lines — 58 cells * 2 = 116 world units, centered at 58,0,58
  const gridHelper = new THREE.GridHelper(120, 60, 0x0d2a3d, 0x0d2a3d)
  gridHelper.position.set(58, 0, 58)
  gridHelper.material.opacity = 0.85
  gridHelper.material.transparent = true
  scene.add(gridHelper)
}

export function worldPos(gameX, gameY) {
  return new THREE.Vector3(gameX * CELL + CELL / 2, 0, gameY * CELL + CELL / 2)
}

export function panCameraTo(gameX, gameY, animate = true) {
  const target = new THREE.Vector3(gameX * CELL + 9 * CELL, 0, gameY * CELL + 9 * CELL)
  const offset = camera.position.clone().sub(controls.target)
  if (animate) {
    controls.target.lerp(target, 0.15)
    camera.position.copy(controls.target.clone().add(offset))
  } else {
    controls.target.copy(target)
    camera.position.copy(target.clone().add(offset))
  }
  controls.update()
}

export function focusOnShip(gameX, gameY) {
  const target = new THREE.Vector3(gameX * CELL + CELL / 2, 0, gameY * CELL + CELL / 2)
  controls.target.copy(target)
  camera.position.set(target.x + 4, 12, target.z + 8)
  controls.update()
}

export function render(delta) {
  controls.update()
  renderer.render(scene, camera)
}
