const apiPrefixes = ["/equipes", "/monde", "/market", "/regles"];
const serverLink = "http://" + process.env.KEYCLOAK_LINK;
const apiBase = "http://" + process.env.API_BASE;

let accessToken = process.env.API_TOKEN || "";

async function refresh() {
	const url = serverLink + "/realms/24hcode/protocol/openid-connect/token";
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: "vaissals-backend",
			username: process.env.LOGIN,
			password: process.env.PASSWORD,
			grant_type: "password",
		}),
	});
	const data = await res.json();
	if (data.access_token) {
		accessToken = data.access_token;
		console.log("✅ Token Keycloak récupéré");
	} else {
		console.error("❌ Refresh token échoué:", JSON.stringify(data));
		console.log("⚠️  Utilisation de API_TOKEN depuis .env");
	}
}

setInterval(refresh, 59 * 60 * 1000);
await refresh();

Bun.serve({
	port: 3000,
	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname === "/token") {
			return new Response(JSON.stringify({ access_token: accessToken }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		if (apiPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
			const body = req.method !== "GET" && req.method !== "HEAD"
				? await req.arrayBuffer()
				: undefined;

			const res = await fetch(apiBase + url.pathname + url.search, {
				method: req.method,
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": req.headers.get("Content-Type") || "application/json",
				},
				body,
			});

			const text = await res.text();
			console.log(req.method, url.pathname, "→", res.status);
			return new Response(text, {
				status: res.status,
				headers: { "Content-Type": "application/json" },
			});
		}

		const path = url.pathname === "/" ? "/index.html" : url.pathname;
		const file = Bun.file(import.meta.dir + "/dist" + path);
		if (!(await file.exists())) {
			return new Response("Not found", { status: 404 });
		}
		return new Response(file);
	},
});
