import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const loader = new GLTFLoader();
const cache = new Map();

const SHIP_MODEL_MAP = {
  AMIRAL: "/assets/vaisseaux_3D/amiral_2.glb",
  CHASSEUR_LEGER: "/assets/vaisseaux_3D/chasseur_leger_1.glb",
  CHASSEUR_MOYEN: "/assets/vaisseaux_3D/chasseur_moyen_1.glb",
  CHASSEUR_LOURD: "/assets/vaisseaux_3D/croiseur_lourd_1.glb",
  CROISEUR_LEGER: "/assets/vaisseaux_3D/croiseur_moyen_1.glb",
  CROISEUR_MOYEN: "/assets/vaisseaux_3D/croiseur_moyen_2.glb",
  CROISEUR_LOURD: "/assets/vaisseaux_3D/croiseur_lourd_2.glb",
  CARGO_LEGER: "/assets/vaisseaux_3D/cargo_leger_1.glb",
  CARGO_MOYEN: "/assets/vaisseaux_3D/cargo_moyen_1.glb",
  CARGO_LOURD: "/assets/vaisseaux_3D/cargo_lourd_1.glb",
  SONDE: "/assets/vaisseaux_3D/sonde_1.glb"
};

const MODULE_MODEL_MAP = {
  DEFENSE_PLANETAIRE: "/assets/modules_3D/defense.glb",
  DECHARGEMENT_RESSOURCE: "/assets/modules_3D/dechargement.glb",
  CONSTRUCTION_VAISSEAUX: "/assets/modules_3D/chantier_moyen.glb",
  CONSTRUCTION_VAISSEAUX_AVANCEE: "/assets/modules_3D/chantier_lourd.glb",
  GOUVERNANCE_PLANETAIRE: "/assets/modules_3D/gouvernance.glb",
  FORTERESSE: "/assets/modules_3D/forteresse.glb"
};

async function loadGlb(url) {
  if (cache.has(url)) {
    return cache.get(url).clone();
  }

  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (gltf) => {
        cache.set(url, gltf.scene);
        resolve(gltf.scene.clone());
      },
      undefined,
      reject
    );
  });
}

function normalizeModel(model, maxSize, withShadows = true) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  if (maxDim > 0) {
    const scale = maxSize / maxDim;
    model.scale.setScalar(scale);
  }

  model.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = withShadows;
      child.receiveShadow = false;
      if (child.material) {
        child.material = child.material.clone();
      }
    }
  });

  return model;
}

export async function loadShipModel(classe) {
  const url = SHIP_MODEL_MAP[classe] || SHIP_MODEL_MAP.SONDE;

  try {
    return normalizeModel(await loadGlb(url), 0.8);
  } catch {
    return new THREE.Mesh(
      new THREE.ConeGeometry(0.28, 0.7, 6),
      new THREE.MeshPhongMaterial({ color: 0x58b7ff, emissive: 0x082548 })
    );
  }
}

export async function loadModuleModel(type) {
  const url = MODULE_MODEL_MAP[type] || MODULE_MODEL_MAP.GOUVERNANCE_PLANETAIRE;

  try {
    return normalizeModel(await loadGlb(url), 0.45, false);
  } catch {
    return new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.18, 0.18),
      new THREE.MeshPhongMaterial({ color: 0xffc95e, emissive: 0x5a3000 })
    );
  }
}

export async function preloadAllModels(onProgress) {
  const urls = [...new Set([...Object.values(SHIP_MODEL_MAP), ...Object.values(MODULE_MODEL_MAP)])];
  let loaded = 0;

  await Promise.allSettled(
    urls.map((url) =>
      loadGlb(url).finally(() => {
        loaded += 1;
        onProgress?.(loaded, urls.length);
      })
    )
  );
}
