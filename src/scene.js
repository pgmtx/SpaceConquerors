import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

export let renderer, scene, camera, controls, clock

const CELL = 2 // world units per cell

export function initScene(container) {
  clock = new THREE.Clock()

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2
  container.appendChild(renderer.domElement)

  // Scene
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000205)
  scene.fog = new THREE.FogExp2(0x000205, 0.012)

  // Camera — perspective, angled down
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500)
  camera.position.set(18, 22, 22)
  camera.lookAt(18, 0, 18)

  // Controls
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.minDistance = 8
  controls.maxDistance = 60
  controls.maxPolarAngle = Math.PI / 2.2
  controls.screenSpacePanning = true

  // Lights
  const ambient = new THREE.AmbientLight(0x111830, 0.6)
  scene.add(ambient)

  const sun = new THREE.DirectionalLight(0x8899ff, 1.2)
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

  const rimLight = new THREE.DirectionalLight(0x002244, 0.4)
  rimLight.position.set(-20, 10, -20)
  scene.add(rimLight)

  // Starfield
  buildStarfield()

  // Nebula background
  buildNebula()

  // Grid base plane
  buildGridPlane()

  // Resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
  })

  return { renderer, scene, camera, controls }
}

function buildStarfield() {
  const count = 4000
  const positions = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(2 * Math.random() - 1)
    const r = 200 + Math.random() * 100
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
    positions[i * 3 + 2] = r * Math.cos(phi)
    sizes[i] = Math.random() > 0.95 ? 2.5 : 1.0
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1))

  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.8,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.85,
  })
  scene.add(new THREE.Points(geo, mat))
}

function buildNebula() {
  // Distant colored dust clouds
  const nebulaColors = [0x110033, 0x001133, 0x002211]
  for (let n = 0; n < 3; n++) {
    const count = 300
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 300
      positions[i * 3 + 1] = (Math.random() - 0.5) * 100 - 10
      positions[i * 3 + 2] = (Math.random() - 0.5) * 300
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      color: nebulaColors[n],
      size: 4,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.15,
    })
    scene.add(new THREE.Points(geo, mat))
  }
}

function buildGridPlane() {
  // Large dark floor
  const geo = new THREE.PlaneGeometry(200, 200)
  const mat = new THREE.MeshLambertMaterial({
    color: 0x020812,
    transparent: true,
    opacity: 0.95,
  })
  const plane = new THREE.Mesh(geo, mat)
  plane.rotation.x = -Math.PI / 2
  plane.position.set(58, -0.05, 58)
  plane.receiveShadow = true
  scene.add(plane)

  // Grid lines
  const gridHelper = new THREE.GridHelper(200, 100, 0x0a1a2a, 0x0a1a2a)
  gridHelper.position.set(58, 0, 58)
  gridHelper.material.opacity = 0.4
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
