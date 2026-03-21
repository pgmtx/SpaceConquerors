export async function get(path) {
	const res = await fetch(path);
	return res.json();
}
