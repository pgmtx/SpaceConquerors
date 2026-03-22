function samePlanetIdentity(leftPlanet, rightPlanet) {
  if (!leftPlanet || !rightPlanet) {
    return false;
  }

  const leftId = leftPlanet.identifiant || leftPlanet.idPlanete || leftPlanet.planeteId || null;
  const rightId = rightPlanet.identifiant || rightPlanet.idPlanete || rightPlanet.planeteId || null;

  if (leftId && rightId) {
    return leftId === rightId;
  }

  if (
    leftPlanet.coord_x !== undefined &&
    leftPlanet.coord_y !== undefined &&
    rightPlanet.coord_x !== undefined &&
    rightPlanet.coord_y !== undefined
  ) {
    return leftPlanet.coord_x === rightPlanet.coord_x && leftPlanet.coord_y === rightPlanet.coord_y;
  }

  if (leftPlanet.nom && rightPlanet.nom) {
    return leftPlanet.nom === rightPlanet.nom;
  }

  return false;
}

export function normalizeTeamId(teamId) {
  if (!teamId) {
    return null;
  }

  if (typeof teamId === "string") {
    return teamId;
  }

  return (
    teamId.idEquipe ||
    teamId.teamId ||
    teamId.id ||
    normalizeTeamId(teamId.proprietaire) ||
    normalizeTeamId(teamId.owner) ||
    normalizeTeamId(teamId.equipe) ||
    null
  );
}

function findPlanetCell(planet, { cell = null, selectedCell = null, mapCells = [] } = {}) {
  if (cell?.planete && samePlanetIdentity(cell.planete, planet)) {
    return cell;
  }

  if (selectedCell?.planete && samePlanetIdentity(selectedCell.planete, planet)) {
    return selectedCell;
  }

  return (
    mapCells.find((mapCell) => mapCell?.planete && samePlanetIdentity(mapCell.planete, planet)) ||
    null
  );
}

function findTeamPlanetOwner(planet, teams = []) {
  if (!planet) {
    return null;
  }

  for (const team of teams || []) {
    const teamId = normalizeTeamId(team);
    if (!teamId) {
      continue;
    }

    if ((team.planetes || []).some((teamPlanet) => samePlanetIdentity(teamPlanet, planet))) {
      return teamId;
    }
  }

  return null;
}

function findModulePlanetOwner(planet, { myTeam = null } = {}) {
  if (!planet) {
    return null;
  }

  const planetId = planet.identifiant || planet.idPlanete || planet.planeteId || null;

  if (planetId && (myTeam?.modules || []).some((module) => module.idPlanete === planetId)) {
    return normalizeTeamId(myTeam);
  }

  const moduleOwners = [...new Set(
    (planet.modules || [])
      .map((module) => normalizeTeamId(module?.proprietaire))
      .filter(Boolean)
  )];

  return moduleOwners.length === 1 ? moduleOwners[0] : null;
}

export function getPlanetOwnerId(
  planet,
  {
    cell = null,
    selectedCell = null,
    mapCells = [],
    teams = [],
    myTeam = null
  } = {}
) {
  if (!planet) {
    return null;
  }

  const directOwnerId =
    normalizeTeamId(planet.proprietaire) ||
    normalizeTeamId(planet.owner) ||
    normalizeTeamId(planet.equipe) ||
    normalizeTeamId(planet.idEquipe) ||
    normalizeTeamId(planet.teamId);

  if (directOwnerId) {
    return directOwnerId;
  }

  const owningTeamId = findTeamPlanetOwner(planet, teams);
  if (owningTeamId) {
    return owningTeamId;
  }

  const matchedCell = findPlanetCell(planet, { cell, selectedCell, mapCells });
  const cellOwnerId =
    normalizeTeamId(matchedCell?.proprietaire) ||
    normalizeTeamId(matchedCell?.owner) ||
    normalizeTeamId(matchedCell?.equipe) ||
    normalizeTeamId(matchedCell?.idEquipe) ||
    normalizeTeamId(matchedCell?.planete?.proprietaire);

  if (cellOwnerId) {
    return cellOwnerId;
  }

  return findModulePlanetOwner(planet, { myTeam });
}
