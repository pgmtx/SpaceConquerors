import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three";

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
	SONDE: "/assets/vaisseaux_3D/sonde_1.glb",
};

const MODULE_MODEL_MAP = {
	DEFENSE_PLANETAIRE: "/assets/modules_3D/defense.glb",
	DECHARGEMENT_RESSOURCE: "/assets/modules_3D/dechargement.glb",
	CONSTRUCTION_VAISSEAUX: "/assets/modules_3D/chantier_moyen.glb",
	CONSTRUCTION_VAISSEAUX_AVANCEE: "/assets/modules_3D/chantier_lourd.glb",
	GOUVERNANCE_PLANETAIRE: "/assets/modules_3D/gouvernance.glb",
	FORTERESSE: "/assets/modules_3D/forteresse.glb",
};

async function loadGLB(url) {
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
			(err) => {
				console.warn("GLB load failed:", url, err);
				reject(err);
			},
		);
	});
}

export async function loadShipModel(classe) {
	const url = SHIP_MODEL_MAP[classe] || SHIP_MODEL_MAP.SONDE;
	try {
		const model = await loadGLB(url);
		// Normalize size to fit in a 0.6 unit bounding box
		const box = new THREE.Box3().setFromObject(model);
		const size = box.getSize(new THREE.Vector3());
		const maxDim = Math.max(size.x, size.y, size.z);
		if (maxDim > 0) {
			const scale = 0.6 / maxDim;
			model.scale.setScalar(scale);
		}
		model.traverse((child) => {
			if (child.isMesh) {
				child.castShadow = true;
				child.receiveShadow = false;
			}
		});
		return model;
	} catch {
		// Fallback: colored box
		const geo = new THREE.BoxGeometry(0.4, 0.2, 0.4);
		const mat = new THREE.MeshPhongMaterial({
			color: 0x4488ff,
			emissive: 0x001133,
		});
		return new THREE.Mesh(geo, mat);
	}
}

export async function loadModuleModel(type) {
	const url = MODULE_MODEL_MAP[type] || MODULE_MODEL_MAP.GOUVERNANCE_PLANETAIRE;
	try {
		const model = await loadGLB(url);
		const box = new THREE.Box3().setFromObject(model);
		const size = box.getSize(new THREE.Vector3());
		const maxDim = Math.max(size.x, size.y, size.z);
		if (maxDim > 0) {
			const scale = 0.25 / maxDim;
			model.scale.setScalar(scale);
		}
		return model;
	} catch {
		const geo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
		const mat = new THREE.MeshPhongMaterial({ color: 0xffaa00 });
		return new THREE.Mesh(geo, mat);
	}
}

// Pre-load all ship models in background
export function preloadAllModels(onProgress) {
	const urls = Object.values(SHIP_MODEL_MAP);
	let loaded = 0;
	return Promise.allSettled(
		urls.map((url) =>
			loadGLB(url).then(() => {
				loaded++;
				onProgress && onProgress(loaded, urls.length);
			}),
		),
	);
}
