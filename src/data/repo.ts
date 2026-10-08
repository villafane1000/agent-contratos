// Acceso de solo lectura a los fixtures: maestro congelado (CSV), catálogo de comerciales y buzón.
// [AJUSTAR] nombres de columnas/campos cuando lleguen los fixtures oficiales: todo el mapeo vive aquí.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
const BASE = () => process.env.FIXTURES_DIR ?? join(RAIZ, "fixtures", "reto-02");

export interface RegistroContrato {
  numero: string; cliente: string; nitCliente: string; objeto: string; valor: number; moneda: string;
  fechaInicio: string; fechaFin: string; comercialCorreo: string; region: string; estado: string; rutaDocumento: string;
  origen?: string; historial?: string[];
}
export interface Comercial { correo: string; nombre: string; region: string }
export interface Correo { id: string; de: string; para?: string; asunto: string; fecha: string; cuerpo: string; adjuntos?: string[] }
export interface Adjunto { nombre: string; texto: string }
export interface Mensaje { id: string; correo: Correo; adjuntos: Adjunto[] }

/** CSV mínimo con soporte de comillas (RFC 4180). */
export function parseCsv(texto: string): Record<string, string>[] {
  const filas: string[][] = []; let fila: string[] = [], celda = "", q = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (q) { if (ch === '"' && texto[i + 1] === '"') { celda += '"'; i++; } else if (ch === '"') q = false; else celda += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { fila.push(celda); celda = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && texto[i + 1] === "\n") i++; fila.push(celda); celda = ""; if (fila.some((c) => c !== "")) filas.push(fila); fila = []; }
    else celda += ch;
  }
  fila.push(celda); if (fila.some((c) => c !== "")) filas.push(fila);
  const [cab, ...resto] = filas;
  return resto.map((f) => Object.fromEntries(cab.map((c, i) => [c.trim(), (f[i] ?? "").trim()])));
}

export function maestroBase(): RegistroContrato[] {
  return parseCsv(readFileSync(join(BASE(), "maestro-contratos.csv"), "utf8")).map((r) => ({
    numero: r.numero_contrato, cliente: r.cliente, nitCliente: r.nit_cliente, objeto: r.objeto, valor: Number(r.valor), moneda: r.moneda || "COP",
    fechaInicio: r.fecha_inicio, fechaFin: r.fecha_fin, comercialCorreo: r.comercial_correo, region: r.region, estado: r.estado, rutaDocumento: r.ruta_documento,
    origen: "maestro 2026-05-30",
  }));
}

export const comerciales = (): Comercial[] => JSON.parse(readFileSync(join(BASE(), "comerciales.json"), "utf8"));

export function listarMensajes(): string[] {
  return readdirSync(join(BASE(), "buzon"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export function leerMensaje(id: string): Mensaje {
  if (!/^[\w-]+$/.test(id) || !listarMensajes().includes(id)) throw new Error(`No existe el mensaje ${id}`);
  const dir = join(BASE(), "buzon", id);
  const correo = JSON.parse(readFileSync(join(dir, "correo.json"), "utf8")) as Correo;
  const nombres = readdirSync(dir).filter((f) => f !== "correo.json" && /\.(txt|md)$/i.test(f)).sort();
  return { id, correo: { ...correo, id: correo.id ?? id }, adjuntos: nombres.filter((n) => existsSync(join(dir, n))).map((nombre) => ({ nombre, texto: readFileSync(join(dir, nombre), "utf8") })) };
}
