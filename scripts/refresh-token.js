function parseEnv(text) {
  const entries = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    let [, key, value] = match;
    value = value.trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  }

  return entries;
}

function normalizeUrl(value, fallbackProtocol = "http") {
  if (!value) {
    return "";
  }

  const trimmed = value.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `${fallbackProtocol}://${trimmed}`;
}

function decodeJwtPayload(token) {
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4 || 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

function isPlaceholderValue(value) {
  if (!value) {
    return false;
  }

  return [
    "votre_login",
    "votre_mot_de_passe",
    "xxx"
  ].includes(value.trim().toLowerCase());
}

function hasUsableStoredAccessToken(env) {
  const token = env.ACCESS_TOKEN || env.API_TOKEN || "";
  if (!token) {
    return false;
  }

  if (!env.TOKEN_EXPIRES_AT) {
    return true;
  }

  const expiresAt = new Date(env.TOKEN_EXPIRES_AT);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > Date.now() + 30_000;
}

function stringifyEnv(env) {
  return `${Object.entries(env)
    .map(([key, value]) => `${key}="${String(value ?? "").replaceAll('"', '\\"')}"`)
    .join("\n")}\n`;
}

const envPath = `${import.meta.dir}/../.env`;
const file = Bun.file(envPath);
const env = (await file.exists()) ? parseEnv(await file.text()) : {};

const keycloakBase = normalizeUrl(
  env.KEYCLOAK_URL ||
    env.KEYCLOAK_LINK ||
    process.env.KEYCLOAK_URL ||
    process.env.KEYCLOAK_LINK
);
if (!keycloakBase) {
  throw new Error("KEYCLOAK_URL est absent du .env");
}

async function requestToken(params) {
  const response = await fetch(
    `${keycloakBase}/realms/24hcode/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: "vaissals-backend",
        ...params
      })
    }
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error_description || payload.message || `OIDC ${response.status}`);
  }

  return payload;
}

let payload = null;

if (hasUsableStoredAccessToken(env) && !env.REFRESH_TOKEN) {
  payload = {
    access_token: env.ACCESS_TOKEN || env.API_TOKEN,
    refresh_token: env.REFRESH_TOKEN || "",
    expires_in: env.TOKEN_EXPIRES_AT
      ? Math.max(0, Math.floor((new Date(env.TOKEN_EXPIRES_AT).getTime() - Date.now()) / 1000))
      : undefined
  };
  console.log("Access token déjà présent dans le .env, aucun refresh distant nécessaire.");
}

if (!payload && env.REFRESH_TOKEN) {
  try {
    payload = await requestToken({
      grant_type: "refresh_token",
      refresh_token: env.REFRESH_TOKEN
    });
    console.log("Refresh via refresh_token réussi.");
  } catch (error) {
    console.warn("Refresh token expiré, fallback password grant:", error.message);
  }
}

if (!payload) {
  const username = env.USERNAME || env.LOGIN || process.env.USERNAME || process.env.LOGIN;
  const password = env.PASSWORD || process.env.PASSWORD;

  if (!username || !password) {
    throw new Error("USERNAME/PASSWORD absents du .env");
  }

  if (isPlaceholderValue(username) || isPlaceholderValue(password)) {
    throw new Error("USERNAME/PASSWORD semblent encore contenir les valeurs d'exemple du .env");
  }

  payload = await requestToken({
    username,
    password,
    grant_type: "password"
  });
  console.log("Refresh via password grant réussi.");
}

const jwtPayload = decodeJwtPayload(payload.access_token || "");
const expiresAt = payload.expires_in
  ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
  : "";

const nextEnv = {
  ...env,
  ...(env.API_TOKEN !== undefined ? { API_TOKEN: payload.access_token || env.API_TOKEN || "" } : {}),
  ACCESS_TOKEN: payload.access_token || env.ACCESS_TOKEN || "",
  REFRESH_TOKEN: payload.refresh_token || env.REFRESH_TOKEN || "",
  TOKEN_EXPIRES_AT: expiresAt,
  TEAM_ID: jwtPayload.team_id || env.TEAM_ID || ""
};

await Bun.write(envPath, stringifyEnv(nextEnv));

console.log("Le .env a été mis à jour avec les nouveaux tokens.");
console.log(`access_token expire dans ${payload.expires_in ?? "?"} secondes.`);
