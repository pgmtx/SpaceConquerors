const apiPrefixes = ["/equipes", "/monde", "/market", "/regles"];
const apiBase = "http://" + process.env.KEYCLOAK_LINK;

let accessToken = process.env.ACCESS_TOKEN;
let refreshToken = process.env.REFRESH_TOKEN;

async function refresh() {
	const res = await fetch(
		apiBase + "/realms/24hcode/protocol/openid-connect/token",
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
	refreshToken = data.refresh_token; // le nouveau refresh token
}

setInterval(refresh, 59 * 60 * 1000);
await refresh();

Bun.serve({
	port: 3000,
	async fetch(req) {
		const url = new URL(req.url);
		if (apiPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
			const res = await fetch(apiBase + url.pathname + url.search, {
				headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },
			});
			const text = await res.text(); // consomme le body
			console.log(res.status, text);
			return new Response(text, {
				headers: { "Content-Type": "application/json" },
			});
		}

		const path = url.pathname === "/" ? "/index.html" : url.pathname;
		const file = Bun.file(import.meta.dir + "/public" + path);
		if (!(await file.exists())) {
			return new Response("Not found", { status: 404 });
		}
		return new Response(file);
	},
});
