// Handler HTTP compartido por Vercel (api/*.ts) y el servidor local (scripts/dev-server.ts).
import { turno, apiKey, MODEL, type Peticion } from "./agent/runtime.js";

export async function manejarChat(req: Request): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "Usa POST" }, { status: 405 });
  let body: Peticion;
  try { body = (await req.json()) as Peticion; } catch { return Response.json({ error: "JSON inválido" }, { status: 400 }); }
  try { return Response.json(await turno(body)); }
  catch (e) {
    const msg = (e as Error).message;
    console.error("[chat]", msg);
    // Degradación controlada: si el modelo falla, se informa y el cliente puede pasar a modo reglas
    return Response.json({ error: msg, sugerencia: "Puedes cambiar al modo sin LLM" }, { status: 502 });
  }
}

export const estado = () => Response.json({ ok: true, servicio: "agente-contratos", modoLlmDisponible: !!apiKey(), modelo: MODEL });
