import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export let renderer;
export let scene;
export let camera;
export let controls;

const CELL_SIZE = 2;
const MAP_SIZE = 58;

export function initScene(container) {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020814);
  scene.fog = new THREE.FogExp2(0x020814, 0.0044);

  camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 500);
  camera.position.set(22, 32, 22);
  camera.lookAt(18, 0, 18);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 10;
  controls.maxDistance = 220;
  controls.maxPolarAngle = Math.PI / 2.15;
  controls.screenSpacePanning = true;

  const ambient = new THREE.AmbientLight(0x1f3559, 0.72);
  scene.add(ambient);

  const mainLight = new THREE.DirectionalLight(0x90b4ff, 1.4);
  mainLight.position.set(36, 58, 30);
  mainLight.castShadow = true;
  mainLight.shadow.mapSize.set(2048, 2048);
  mainLight.shadow.camera.near = 10;
  mainLight.shadow.camera.far = 210;
  mainLight.shadow.camera.left = -50;
  mainLight.shadow.camera.right = 50;
  mainLight.shadow.camera.top = 50;
  mainLight.shadow.camera.bottom = -50;
  scene.add(mainLight);

  const rimLight = new THREE.DirectionalLight(0x214f8d, 0.38);
  rimLight.position.set(-16, 10, -14);
  scene.add(rimLight);

  buildStarfield();
  buildNebula();
  buildGridPlane();

  window.addEventListener("resize", () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  });
}

function buildStarfield() {
  const count = 5000;
  const positions = new Float32Array(count * 3);

  for (let i = 0; i < count; i += 1) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const radius = 220 + Math.random() * 140;
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  scene.add(
    new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        color: 0xe8f6ff,
        size: 0.8,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.95
      })
    )
  );
}

function buildNebula() {
  const colors = [0x15396f, 0x17324f, 0x0f503f, 0x30175f];

  colors.forEach((color) => {
    const count = 380;
    const positions = new Float32Array(count * 3);

    for (let i = 0; i < count; i += 1) {
      positions[i * 3] = (Math.random() - 0.5) * 340;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 120 - 8;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 340;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    scene.add(
      new THREE.Points(
        geometry,
        new THREE.PointsMaterial({
          color,
          size: 5.6,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.1
        })
      )
    );
  });
}

function buildGridPlane() {
  const worldSize = MAP_SIZE * CELL_SIZE;

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(worldSize + 8, worldSize + 8),
    new THREE.MeshLambertMaterial({
      color: 0x040d1d,
      transparent: true,
      opacity: 0.98
    })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(worldSize / 2, -0.05, worldSize / 2);
  plane.receiveShadow = true;
  scene.add(plane);

  const grid = new THREE.GridHelper(worldSize + 4, MAP_SIZE + 2, 0x13345b, 0x102744);
  grid.position.set(worldSize / 2, 0, worldSize / 2);
  grid.material.opacity = 0.72;
  grid.material.transparent = true;
  scene.add(grid);
}

export function worldPos(gameX, gameY) {
  return new THREE.Vector3(gameX * CELL_SIZE + CELL_SIZE / 2, 0, gameY * CELL_SIZE + CELL_SIZE / 2);
}

export function panCameraTo(gameX, gameY, animate = true) {
  const target = new THREE.Vector3(
    gameX * CELL_SIZE + 9 * CELL_SIZE,
    0,
    gameY * CELL_SIZE + 9 * CELL_SIZE
  );
  const offset = camera.position.clone().sub(controls.target);

  if (animate) {
    controls.target.lerp(target, 0.15);
    camera.position.copy(controls.target.clone().add(offset));
  } else {
    controls.target.copy(target);
    camera.position.copy(target.clone().add(offset));
  }

  controls.update();
}

export function focusOnShip(gameX, gameY) {
  const target = worldPos(gameX, gameY);
  controls.target.copy(target);
  camera.position.set(target.x + 5, 12, target.z + 9);
  controls.update();
}

export function focusOnWholeMap() {
  const worldSize = MAP_SIZE * CELL_SIZE;
  const center = worldSize / 2;
  controls.target.set(center, 0, center);
  camera.position.set(center, 150, center + 24);
  controls.update();
}

export function render() {
  controls.update();
  renderer.render(scene, camera);
}
