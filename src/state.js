// Shared application state
export const state = {
  // Auth
  token: '',
  teamId: '',
  teamName: '',

  // Map viewport (top-left corner in game coords)
  viewX: 0,
  viewY: 0,
  viewSize: 18,

  // Game data
  mapCells: [],       // Array<Case> from API
  allTeams: [],       // Array<Equipe>
  myTeam: null,       // Equipe

  // Selection
  selectedShip: null,
  selectedPlanet: null,
  selectedCell: null,

  // Minimap data (full visible planets from multiple queries)
  minimapPlanets: [],

  // Pending ship action (waiting for click target)
  pendingAction: null,

  // Refresh control
  lastRefresh: 0,
  refreshInterval: 5000, // ms
}
