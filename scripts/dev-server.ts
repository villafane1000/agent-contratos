// Servidor local para desarrollo: npx tsx scripts/dev-server.ts  (o bun scripts/dev-server.ts). Abre http://localhost:3000
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { manejarChat, estado } from "../src/http.js";

const PORT = Number(process.env.PORT ?? 3000);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  let r: Response;
  if (url.pathname === "/api/chat") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    r = await manejarChat(new Request(url, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }));
  } else if (url.pathname === "/api/estado" || url.pathname === "/api/health") {
    r = estado();
  } else {
    try { r = new Response(await readFile(new URL("../public/index.html", import.meta.url)), { headers: { "content-type": "text/html; charset=utf-8" } }); }
    catch { r = new Response("No encontrado", { status: 404 }); }
  }
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, () => console.log(`Agente de contratos en http://localhost:${PORT}`));
