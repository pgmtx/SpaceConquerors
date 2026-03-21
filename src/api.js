function decodeBase64Url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return atob(padded);
}

export function getTeamIdFromToken(token) {
  try {
    const payload = JSON.parse(decodeBase64Url(token.split(".")[1]));
    return payload.team_id || "";
  } catch {
    return "";
  }
}

async function apiFetch(path, options = {}) {
  const headers = {
    ...options.headers
  };

  if (options.body !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(path, {
    ...options,
    headers
  });

  if (!response.ok) {
    let message = response.statusText || `HTTP ${response.status}`;

    try {
      const errorPayload = await response.json();
      message = errorPayload.message || errorPayload.error_description || message;
    } catch {
      const errorText = await response.text().catch(() => "");
      if (errorText) {
        message = errorText;
      }
    }

    throw new Error(message);
  }

  if (response.status === 201 || response.status === 204) {
    return null;
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return response.text();
  }

  return response.json();
}

export function getMap(xMin, xMax, yMin, yMax) {
  return apiFetch(`/monde/map?x_range=${xMin},${xMax}&y_range=${yMin},${yMax}`);
}

export function getAllTeams() {
  return apiFetch("/equipes");
}

export function getTeam(teamId) {
  return apiFetch(`/equipes/${teamId}`);
}

export function getShips(teamId) {
  return apiFetch(`/equipes/${teamId}/vaisseaux`);
}

export function getShip(teamId, shipId) {
  return apiFetch(`/equipes/${teamId}/vaisseaux/${shipId}`);
}

export function buildShip(teamId, body) {
  return apiFetch(`/equipes/${teamId}/vaisseau/construire`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function doAction(teamId, shipId, action, coordX, coordY) {
  const body = { action };
  if (coordX !== undefined) {
    body.coord_x = coordX;
  }
  if (coordY !== undefined) {
    body.coord_y = coordY;
  }

  return apiFetch(`/equipes/${teamId}/vaisseaux/${shipId}/demander-action`, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function renameShip(teamId, shipId, nom) {
  return apiFetch(`/equipes/${teamId}/vaisseaux/${shipId}/renommer`, {
    method: "PATCH",
    body: JSON.stringify({ nom })
  });
}

export function getModules(teamId) {
  return apiFetch(`/equipes/${teamId}/modules`);
}

export function placeModule(teamId, moduleId, planetId) {
  return apiFetch(`/equipes/${teamId}/module/${moduleId}/poser`, {
    method: "PUT",
    body: JSON.stringify({
      idModule: moduleId,
      idPlanete: planetId
    })
  });
}

export function removeModule(teamId, moduleId) {
  return apiFetch(`/equipes/${teamId}/module/${moduleId}/supprimer`, {
    method: "DELETE"
  });
}

export function getPlans(teamId) {
  return apiFetch(`/equipes/${teamId}/plans`);
}

export function getMarketOffers() {
  return apiFetch("/market/offres");
}

export function buyOffer(offerId) {
  return apiFetch(`/market/offres/${offerId}`);
}

export function createOffer(body) {
  return apiFetch("/market/offres", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function deleteOffer(offerId) {
  return apiFetch(`/market/offres/${offerId}`, {
    method: "DELETE"
  });
}

export function getGameParams() {
  return apiFetch("/regles/parametrage");
}
