export function getTeamIdFromToken(token) {
	try {
		const payload = JSON.parse(
			atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
		);
		return payload.team_id || "";
	} catch {
		return "";
	}
}

async function apiFetch(path, options = {}) {
	const res = await fetch(path, {
		...options,
		headers: {
			"Content-Type": "application/json",
			...options.headers,
		},
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({ message: res.statusText }));
		throw new Error(err.message || `HTTP ${res.status}`);
	}
	if (res.status === 204) return null;
	return res.json();
}

// Map
export function getMap(x1, x2, y1, y2) {
	return apiFetch(`/monde/map?x_range=${x1},${x2}&y_range=${y1},${y2}`);
}

// Teams
export function getAllTeams() {
	return apiFetch("/equipes");
}

export function getTeam(teamId) {
	return apiFetch(`/equipes/${teamId}`);
}

// Ships
export function getShips(teamId) {
	return apiFetch(`/equipes/${teamId}/vaisseaux`);
}

export function getShip(teamId, shipId) {
	return apiFetch(`/equipes/${teamId}/vaisseaux/${shipId}`);
}

export function buildShip(teamId, body) {
	return apiFetch(`/equipes/${teamId}/vaisseau/construire`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

export function doAction(teamId, shipId, action, coord_x, coord_y) {
	const body = { action };
	if (coord_x !== undefined) body.coord_x = coord_x;
	if (coord_y !== undefined) body.coord_y = coord_y;
	return apiFetch(`/equipes/${teamId}/vaisseaux/${shipId}/demander-action`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

export function renameShip(teamId, shipId, nom) {
	return apiFetch(`/equipes/${teamId}/vaisseaux/${shipId}/renommer`, {
		method: "PATCH",
		body: JSON.stringify({ nom }),
	});
}

// Modules
export function getModules(teamId) {
	return apiFetch(`/equipes/${teamId}/modules`);
}

// Marketplace
export function getMarketOffers() {
	return apiFetch("/market/offres");
}

// Rules
export function getGameParams() {
	return apiFetch("/regles/parametrage");
}
