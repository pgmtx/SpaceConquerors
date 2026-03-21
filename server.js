const apiPrefixes = ["/equipes", "/monde", "/market", "/regles"];
const serverLink = "http://" + process.env.KEYCLOAK_LINK;
const apiBase = "http://" + process.env.API_BASE;

let accessToken = process.env.ACCESS_TOKEN;
let refreshToken = process.env.REFRESH_TOKEN;

async function refresh() {
	const res = await fetch(
		serverLink + "/realms/24hcode/protocol/openid-connect/token",
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: "vaissals-backend",
				username: process.env.LOGIN,
				password: process.env.PASSWORD,
				grant_type: "password",
			}),
		},
	);
	const data = await res.json();
	accessToken = data.access_token;
	refreshToken = data.refresh_token;
}

setInterval(refresh, 59 * 60 * 1000);
await refresh();

Bun.serve({
	port: 3000,
	async fetch(req) {
		const url = new URL(req.url);
		const targetUrl = apiBase + url.pathname + url.search;
		console.log("→", req.method, targetUrl);

		if (url.pathname === "/token") {
			return new Response(JSON.stringify({ access_token: accessToken }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		if (apiPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
			const res = await fetch(apiBase + url.pathname + url.search, {
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			const text = await res.text();
			console.log(res.status, text);
			return new Response(text, {
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
