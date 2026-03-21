const API_PREFIXES = ["/equipes", "/monde", "/market", "/regles"];

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

async function loadEnvFile() {
  const file = Bun.file(`${import.meta.dir}/.env`);
  if (!(await file.exists())) {
    return {};
  }

  return parseEnv(await file.text());
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

async function saveEnvPatch(patch) {
  const env = {
    ...(await loadEnvFile()),
    ...patch
  };

  await Bun.write(`${import.meta.dir}/.env`, stringifyEnv(env));
  return env;
}

async function requestOidcToken(params) {
  const env = await loadEnvFile();
  const keycloakBase = normalizeUrl(
    process.env.KEYCLOAK_URL ||
      process.env.KEYCLOAK_LINK ||
      env.KEYCLOAK_URL ||
      env.KEYCLOAK_LINK
  );

  if (!keycloakBase) {
    throw new Error("KEYCLOAK_URL est absent du .env");
  }

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

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(payload.error_description || payload.message || `OIDC ${response.status}`);
  }

  return payload;
}

async function refreshFromEnv() {
  const env = await loadEnvFile();

  if (hasUsableStoredAccessToken(env) && !env.REFRESH_TOKEN) {
    return {
      access_token: env.ACCESS_TOKEN || env.API_TOKEN,
      refresh_token: env.REFRESH_TOKEN || "",
      expires_in: env.TOKEN_EXPIRES_AT
        ? Math.max(0, Math.floor((new Date(env.TOKEN_EXPIRES_AT).getTime() - Date.now()) / 1000))
        : undefined
    };
  }

  if (env.REFRESH_TOKEN) {
    try {
      return await requestOidcToken({
        grant_type: "refresh_token",
        refresh_token: env.REFRESH_TOKEN
      });
    } catch (error) {
      console.warn("Refresh token invalide, fallback password grant:", error.message);
    }
  }

  const username = env.USERNAME || env.LOGIN || process.env.USERNAME || process.env.LOGIN;
  const password = env.PASSWORD || process.env.PASSWORD;

  if (!username || !password) {
    throw new Error("USERNAME/PASSWORD absents du .env");
  }

  if (isPlaceholderValue(username) || isPlaceholderValue(password)) {
    throw new Error("USERNAME/PASSWORD semblent encore contenir les valeurs d'exemple du .env");
  }

  return requestOidcToken({
    username,
    password,
    grant_type: "password"
  });
}

let accessToken = process.env.ACCESS_TOKEN || process.env.API_TOKEN || "";
let refreshToken = process.env.REFRESH_TOKEN || "";
let lastRefreshAt = null;
let lastRefreshError = null;

async function syncTokens({ persist = false } = {}) {
  const payload = await refreshFromEnv();

  if (!payload.access_token) {
    throw new Error("Réponse OIDC sans access_token");
  }

  accessToken = payload.access_token;
  refreshToken = payload.refresh_token || refreshToken;
  lastRefreshAt = new Date().toISOString();
  lastRefreshError = null;
  const jwtPayload = decodeJwtPayload(accessToken);
  const expiresAt =
    payload.expires_in
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : "";

  if (persist) {
    const currentEnv = await loadEnvFile();
    await saveEnvPatch({
      ...(currentEnv.API_TOKEN !== undefined ? { API_TOKEN: accessToken } : {}),
      ACCESS_TOKEN: accessToken,
      REFRESH_TOKEN: refreshToken,
      TOKEN_EXPIRES_AT: expiresAt,
      TEAM_ID: jwtPayload.team_id || currentEnv.TEAM_ID || ""
    });
  }

  return payload;
}

function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { ...init, headers });
}

async function proxyApiRequest(req) {
  const env = await loadEnvFile();
  const apiBase = normalizeUrl(
    process.env.BACKEND_URL ||
      process.env.API_BASE ||
      env.BACKEND_URL ||
      env.API_BASE
  );

  if (!apiBase) {
    return json({ message: "BACKEND_URL est absent du .env" }, { status: 500 });
  }

  if (!accessToken) {
    try {
      await syncTokens({ persist: true });
    } catch (error) {
      return json({ message: error.message }, { status: 500 });
    }
  }

  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("host");

  const body =
    req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();

  let response = await fetch(`${apiBase}${url.pathname}${url.search}`, {
    method: req.method,
    headers,
    body
  });

  if (response.status === 401) {
    try {
      await syncTokens({ persist: true });
      headers.set("Authorization", `Bearer ${accessToken}`);
      response = await fetch(`${apiBase}${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body
      });
    } catch (error) {
      lastRefreshError = error.message;
      return json({ message: error.message }, { status: 500 });
    }
  }

  const passthroughHeaders = new Headers();
  const contentType = response.headers.get("content-type");
  if (contentType) {
    passthroughHeaders.set("Content-Type", contentType);
  }

  console.log(req.method, url.pathname, "->", response.status);

  return new Response(response.body, {
    status: response.status,
    headers: passthroughHeaders
  });
}

function getStaticFile(pathname) {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  return Bun.file(`${import.meta.dir}/dist${normalized}`);
}

try {
  await syncTokens({ persist: true });
  console.log("Token initial récupéré");
} catch (error) {
  lastRefreshError = error.message;
  console.warn("Impossible de récupérer le token au démarrage:", error.message);
}

setInterval(async () => {
  try {
    await syncTokens({ persist: true });
    console.log("Token rafraîchi");
  } catch (error) {
    lastRefreshError = error.message;
    console.warn("Rafraîchissement automatique échoué:", error.message);
  }
}, 1000 * 60 * 55);

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/token") {
      return json({
        access_token: accessToken,
        refresh_token: refreshToken,
        lastRefreshAt,
        lastRefreshError
      });
    }

    if (url.pathname === "/health") {
      return json({
        ok: true,
        hasToken: Boolean(accessToken),
        lastRefreshAt,
        lastRefreshError
      });
    }

    if (url.pathname === "/refresh-token" && req.method === "POST") {
      try {
        const payload = await syncTokens({ persist: true });
        return json({
          ok: true,
          expires_in: payload.expires_in,
          refresh_expires_in: payload.refresh_expires_in,
          lastRefreshAt
        });
      } catch (error) {
        return json({ ok: false, message: error.message }, { status: 500 });
      }
    }

    if (API_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      return proxyApiRequest(req);
    }

    const file = getStaticFile(url.pathname);
    if (await file.exists()) {
      return new Response(file);
    }

    const fallback = getStaticFile("/");
    if (await fallback.exists()) {
      return new Response(fallback);
    }

    return new Response("Build manquant. Lancez `bun run build`.", { status: 404 });
  }
});

console.log("Serveur Bun prêt sur http://localhost:3000");
