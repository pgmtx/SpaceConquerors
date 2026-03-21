import { get } from "./api.js";

const equipes = await get("/equipes");
console.log(equipes);
