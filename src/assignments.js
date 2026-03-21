// Assignation des vaisseaux à un rôle : 'ATTACK' | 'MINE' | 'IDLE'
// Module partagé entre les bots et l'UI.

export const Role = Object.freeze({
    ATTACK: "ATTACK",
    MINE:   "MINE",
    IDLE:   "IDLE",
});

const STORAGE_KEY = "ship_assignments";

// shipId → Role
const assignments = new Map();

// Charger depuis localStorage au démarrage
try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    for (const [id, role] of Object.entries(saved)) {
        if (Object.values(Role).includes(role)) assignments.set(id, role);
    }
} catch {}

export function getRole(shipId) {
    return assignments.get(shipId) ?? Role.IDLE;
}

export function setRole(shipId, role) {
    assignments.set(shipId, role);
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(assignments)));
    } catch {}
}

export function getAssignedShips(role) {
    const result = [];
    for (const [id, r] of assignments) {
        if (r === role) result.push(id);
    }
    return result;
}
