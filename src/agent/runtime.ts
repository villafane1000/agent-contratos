// Ciclo del agente. Sin estado en servidor: el cliente reenvía en cada turno el historial y la
// bitácora del maestro (firmada con HMAC). Dos modos: "llm" (Claude con tool use) y "reglas" (sin modelo).
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { herramientas, porNombre, ejecutar } from "../tools/contratos.js";
import { conMaestro, nuevoMaestro } from "../tools/contexto.js";
import { evaluarMensaje, type Evaluacion } from "../domain/controles.js";
import type { Operacion } from "../domain/maestro.js";
import { comerciales, leerMensaje, listarMensajes } from "../data/repo.js";

type Msg = Anthropic.MessageParam;
export type Evento =
  | { tipo: "texto"; texto: string }
  | { tipo: "herramienta"; id: string; nombre: string; input: unknown; resultado?: unknown; error?: string; ms: number }
  | { tipo: "confirmacion"; id: string; nombre: string; input: unknown; decision: "aprobada" | "rechazada" };

/** Resumen determinista que ve la persona antes de aprobar (no lo redacta el modelo). */
export interface ResumenEscritura { mensajeId: string; operacion: string; decision: string; confianza: number; filas: Array<[string, string]>; alertas: string[]; requiereJustificacion: boolean; justificacionPrevia: string | null; bloqueo: string | null }
export interface Pendiente { toolUseId: string; nombre: string; input: Record<string, unknown>; resultadosPrevios: Anthropic.ToolResultBlockParam[]; firma?: string; resumen?: ResumenEscritura }
export interface EstadoMaestro { operaciones: Operacion[]; firma?: string }
export interface Peticion { modo?: "llm" | "reglas"; messages: Msg[]; mensaje?: string; confirmacion?: { toolUseId: string; aprobado: boolean; comentario?: string }; pendiente?: Pendiente; estado?: EstadoMaestro }
export interface Respuesta { modo: "llm" | "reglas"; messages: Msg[]; eventos: Evento[]; pendiente: Pendiente | null; estado: EstadoMaestro; uso: { inputTokens: number; outputTokens: number; costoUSD: number; llamadas: number } }

export const apiKey = () => process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY_GENERAL;
export const MODEL = process.env.MODEL ?? "claude-sonnet-5-5";
const PRECIO_IN = Number(process.env.PRECIO_INPUT_MTOK ?? 3); // USD por millón de tokens (verificar tarifa vigente)
const PRECIO_OUT = Number(process.env.PRECIO_OUTPUT_MTOK ?? 15);
const MAX_ITER = 12;

let systemPrompt: string | null = null;
const prompt = () => (systemPrompt ??= readFileSync(join(fileURLToPath(new URL("../../", import.meta.url)), "agent", "prompt.md"), "utf8"));

const toolsApi: Anthropic.Tool[] = herramientas.map((h) => {
  const { $schema, ...schema } = z.toJSONSchema(h.input) as Record<string, unknown>;
  void $schema;
  return { name: h.name, description: h.description, input_schema: schema as Anthropic.Tool.InputSchema };
});

async function correrHerramienta(id: string, nombre: string, input: unknown, eventos: Evento[]): Promise<Anthropic.ToolResultBlockParam> {
  const t0 = Date.now();
  try {
    const resultado = await ejecutar(nombre, input);
    eventos.push({ tipo: "herramienta", id, nombre, input, resultado, ms: Date.now() - t0 });
    return { type: "tool_result", tool_use_id: id, content: JSON.stringify(resultado) };
  } catch (e) {
    const error = e instanceof z.ZodError ? "Entrada inválida: " + e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : (e as Error).message;
    eventos.push({ tipo: "herramienta", id, nombre, input, error, ms: Date.now() - t0 });
    return { type: "tool_result", tool_use_id: id, content: error, is_error: true };
  }
}

// ── Firmas: la acción pendiente y la bitácora viajan al navegador; no pueden alterarse. ──
const SECRETO = () => process.env.SIGNING_SECRET ?? apiKey() ?? "dev-secret";
const hmac = (x: unknown) => createHmac("sha256", SECRETO()).update(JSON.stringify(x)).digest("hex");
const igual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const firmaPend = (x: Pendiente) => hmac(["pend", x.toolUseId, x.nombre, x.input, x.resultadosPrevios]);
const firmaEstado = (ops: Operacion[]) => hmac(["estado", ops]);

const cop = (n: number) => "$" + Math.round(n).toLocaleString("es-CO");
function resumir(x: Pendiente, ops: Operacion[]): ResumenEscritura | undefined {
  const id = x.input.mensajeId;
  if (x.nombre !== "registrar_en_maestro" || typeof id !== "string") return undefined;
  try {
    const e: Evaluacion = evaluarMensaje(leerMensaje(id), nuevoMaestro(ops), comerciales(), (x.input.correcciones as object) ?? {});
    const p = e.propuesta;
    const filas: Array<[string, string]> = [["Mensaje", `${id} — ${e.asunto}`], ["Operación", e.operacion === "ALTA" ? "Alta de contrato nuevo" : "Actualización por otrosí"]];
    if (p?.registro) {
      const r = p.registro;
      filas.push(["Contrato", r.numero], ["Cliente", `${r.cliente} (NIT ${r.nitCliente})`], ["Objeto", r.objeto], ["Valor", `${cop(r.valor)} ${r.moneda}`], ["Vigencia", `${r.fechaInicio} → ${r.fechaFin}`], ["Comercial", `${e.autoria.nombre ?? e.autoria.correo} (${r.region})`], ["Archivo", r.rutaDocumento]);
    } else if (p?.numero) {
      filas.push(["Contrato", p.numero], ["Otrosí", `No. ${p.otrosi}`]);
      if (p.cambios?.fechaFin) filas.push(["Fecha fin", `${p.antes?.fechaFin} → ${p.cambios.fechaFin}`]);
      if (p.cambios?.valorAdicional) filas.push(["Valor", `${cop(p.antes?.valor ?? 0)} + ${cop(p.cambios.valorAdicional)} = ${cop((p.antes?.valor ?? 0) + p.cambios.valorAdicional)}`]);
      filas.push(["Archivo", e.carpetaArchivo]);
    } else if (e.camposFaltantes.length) filas.push(["Faltan", e.camposFaltantes.join(", ")]);
    const corr = (x.input.correcciones ?? {}) as { comercial?: string };
    // Anticipa lo que la herramienta rechazaría, para no pedir una aprobación que no puede prosperar.
    const bloqueo = e.decision === "RECHAZADO" || e.decision === "DUPLICADO" ? `Decisión ${e.decision}: no se puede escribir.`
      : e.camposFaltantes.length ? `Faltan datos: ${e.camposFaltantes.join(", ")}. Dícteselos al agente en el chat antes de aprobar.`
      : corr.comercial && !e.autoria.enCatalogo ? `"${corr.comercial}" no está en el catálogo de comerciales. Rechaza y pide al agente asignar uno del catálogo (p. ej. "asígnalo a Diana Vargas").`
      : null;
    const justificacionPrevia = typeof x.input.justificacion === "string" ? x.input.justificacion : null;
    return { mensajeId: id, operacion: e.operacion, decision: e.decision, confianza: e.confianza, filas, alertas: e.controles.filter((c) => c.resultado !== "OK").map((c) => `${c.id} ${c.control}: ${c.detalle}`), requiereJustificacion: e.decision === "REQUIERE_REVISION" && !justificacionPrevia, justificacionPrevia, bloqueo };
  } catch { return undefined; }
}
function textoResumen(r: ResumenEscritura): string {
  return [`**${r.mensajeId}** → ${r.decision} (confianza ${Math.round(r.confianza * 100)} %). Propuesta de escritura en el maestro:`, ...r.filas.slice(1).map(([k, v]) => `- **${k}:** ${v}`), ...(r.alertas.length ? [`- **Alertas:** ${r.alertas.join("; ")}`] : []), r.requiereJustificacion ? "Requiere revisión: escribe la justificación en el recuadro antes de aprobar." : "Confirma en el recuadro para escribir en el maestro."].join("\n");
}

export async function turno(p: Peticion): Promise<Respuesta> {
  if (p.confirmacion && (!p.pendiente || !igual(p.pendiente.firma ?? "", firmaPend(p.pendiente)))) throw new Error("Acción pendiente inválida o alterada");
  const ops = p.estado?.operaciones ?? [];
  if (ops.length && !igual(p.estado?.firma ?? "", firmaEstado(ops))) throw new Error("Bitácora del maestro inválida o alterada");
  const maestro = nuevoMaestro(ops);
  const modo = p.modo === "reglas" || !apiKey() ? "reglas" : "llm";
  const r = await conMaestro(maestro, () => (modo === "llm" ? turnoLlm(p) : turnoReglas(p)));
  const nuevasOps = maestro.operaciones;
  const pendiente = r.pendiente ? { ...r.pendiente, firma: firmaPend(r.pendiente), resumen: resumir(r.pendiente, nuevasOps) } : null;
  // Garantía: antes de pedir aprobación, la persona siempre lee un resumen calculado por las reglas.
  if (pendiente?.resumen && (r.modo === "reglas" || r.eventos.at(-1)?.tipo !== "texto")) r.eventos.push({ tipo: "texto", texto: textoResumen(pendiente.resumen) });
  return { ...r, pendiente, estado: { operaciones: nuevasOps, firma: firmaEstado(nuevasOps) } };
}

const costo = (u: Respuesta["uso"]) => ({ ...u, costoUSD: +((u.inputTokens * PRECIO_IN + u.outputTokens * PRECIO_OUT) / 1e6).toFixed(5) });
type Parcial = Omit<Respuesta, "estado">;

// ───────────────────────────── Modo LLM ─────────────────────────────
async function turnoLlm(p: Peticion): Promise<Parcial> {
  const client = new Anthropic({ apiKey: apiKey(), ...(process.env.ANTHROPIC_WORKSPACE_ID ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } } : {}) });
  const messages: Msg[] = [...(p.messages ?? [])];
  const eventos: Evento[] = [];
  const uso = { inputTokens: 0, outputTokens: 0, costoUSD: 0, llamadas: 0 };

  if (p.confirmacion && p.pendiente) {
    const pend = p.pendiente;
    if (pend.toolUseId !== p.confirmacion.toolUseId) throw new Error("La confirmación no corresponde a la acción pendiente");
    let res: Anthropic.ToolResultBlockParam;
    if (p.confirmacion.aprobado) {
      eventos.push({ tipo: "confirmacion", id: pend.toolUseId, nombre: pend.nombre, input: pend.input, decision: "aprobada" });
      // Lo que la persona escribe en el recuadro de aprobación es la justificación que vale.
      const input = { ...pend.input, ...(p.confirmacion.comentario ? { justificacion: p.confirmacion.comentario } : {}) };
      res = await correrHerramienta(pend.toolUseId, pend.nombre, input, eventos);
    } else {
      eventos.push({ tipo: "confirmacion", id: pend.toolUseId, nombre: pend.nombre, input: pend.input, decision: "rechazada" });
      res = { type: "tool_result", tool_use_id: pend.toolUseId, content: `El usuario RECHAZÓ la escritura.${p.confirmacion.comentario ? " Comentario: " + p.confirmacion.comentario : ""} No la reintentes sin nueva instrucción.` };
    }
    messages.push({ role: "user", content: [...pend.resultadosPrevios, res] });
  } else if (p.mensaje) messages.push({ role: "user", content: p.mensaje });

  for (let i = 0; i < MAX_ITER; i++) {
    const r = await client.messages.create({ model: MODEL, max_tokens: 2048, system: prompt(), tools: toolsApi, messages });
    uso.llamadas++; uso.inputTokens += r.usage.input_tokens; uso.outputTokens += r.usage.output_tokens;
    messages.push({ role: "assistant", content: r.content });
    for (const b of r.content) if (b.type === "text" && b.text.trim()) eventos.push({ tipo: "texto", texto: b.text });
    if (r.stop_reason !== "tool_use") break;

    const usos = r.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const resultados: Anthropic.ToolResultBlockParam[] = [];
    let pendiente: Pendiente | null = null;
    for (const u of usos) {
      if (porNombre.get(u.name)?.requiereConfirmacion && !pendiente) pendiente = { toolUseId: u.id, nombre: u.name, input: u.input as Record<string, unknown>, resultadosPrevios: [] };
      else if (porNombre.get(u.name)?.requiereConfirmacion) resultados.push({ type: "tool_result", tool_use_id: u.id, content: "Solo se confirma una escritura a la vez; vuelve a pedirla después.", is_error: true });
      else resultados.push(await correrHerramienta(u.id, u.name, u.input, eventos));
    }
    if (pendiente) { pendiente.resultadosPrevios = resultados; return { modo: "llm", messages, eventos, pendiente, uso: costo(uso) }; }
    messages.push({ role: "user", content: resultados });
  }
  return { modo: "llm", messages, eventos, pendiente: null, uso: costo(uso) };
}

// ─────────────────────── Modo reglas (sin LLM) ───────────────────────
// Respaldo si no hay API key o si el modelo falla. Entiende: "listar", "procesa msg-001", "procesa todo",
// "vencimientos", "maestro", "archiva msg-003".
async function turnoReglas(p: Peticion): Promise<Parcial> {
  const eventos: Evento[] = [];
  const uso = { inputTokens: 0, outputTokens: 0, costoUSD: 0, llamadas: 0 };
  const fin = (pendiente: Pendiente | null = null): Parcial => ({ modo: "reglas", messages: [], eventos, pendiente, uso });
  const say = (texto: string) => eventos.push({ tipo: "texto", texto });
  const tool = async (nombre: string, input: unknown) => { const r = await correrHerramienta(`r-${nombre}-${eventos.length}`, nombre, input, eventos); return r.is_error ? null : JSON.parse(r.content as string); };

  if (p.confirmacion && p.pendiente) {
    const pend = p.pendiente;
    eventos.push({ tipo: "confirmacion", id: pend.toolUseId, nombre: pend.nombre, input: pend.input, decision: p.confirmacion.aprobado ? "aprobada" : "rechazada" });
    if (!p.confirmacion.aprobado) { say("Entendido: no se escribió en el maestro."); return fin(); }
    const r = await tool(pend.nombre, { ...pend.input, ...(p.confirmacion.comentario ? { justificacion: p.confirmacion.comentario } : {}) });
    say(r?.escrito ? `Listo: **${r.numero}** ${r.operacion === "ALTA" ? "registrado" : "actualizado"} en el maestro y archivado en \`${r.archivadoEn}\`.` : `No se escribió en el maestro: ${r?.motivo ?? "error"}`);
    return fin();
  }

  const texto = (p.mensaje ?? "").toLowerCase();
  const ids = texto.match(/msg-\d+/g);
  if (/venc|alerta/.test(texto)) {
    const fecha = texto.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const r = await tool("reporte_vencimientos", fecha ? { fechaCorte: fecha } : {});
    say(`Vencimientos a ${r.fechaCorte} (horizonte ${r.horizonteDias} días): ${r.alertas.length} alertas.\n` + r.alertas.map((a: { nivel: string; numero: string; cliente: string; fechaFin: string; diasRestantes: number }) => `- ${a.nivel} · ${a.numero} ${a.cliente} · vence ${a.fechaFin} (${a.diasRestantes} días)`).join("\n"));
    return fin();
  }
  if (!ids && /maestro|consulta/.test(texto)) {
    const r = await tool("consultar_maestro", {});
    say(`El maestro tiene ${r.total} contratos; ${r.cambiosEnSesion} cambios aprobados en esta sesión.`);
    return fin();
  }
  if (ids && /archiv/.test(texto)) { for (const id of ids) { const r = await tool("archivar_documento", { mensajeId: id }); say(r?.archivado ? `${id} archivado en \`${r.ruta}\`.` : `${id}: ${r?.motivo ?? "error"}`); } return fin(); }
  if (!ids && /list|buz[oó]n|qu[eé] hay|correos/.test(texto)) {
    const l = await tool("listar_buzon", {});
    say(`Hay ${l.length} correos en el buzón: ${l.map((x: { id: string }) => x.id).join(", ")}. Escribe por ejemplo "procesa msg-001".`);
    return fin();
  }
  const objetivo: string[] = ids ?? (/todo|todos/.test(texto) ? listarMensajes() : []);
  if (!objetivo.length) { say('Modo sin LLM. Comandos: "listar", "procesa msg-001", "procesa todo", "vencimientos", "maestro", "archiva msg-003".'); return fin(); }

  const filas: string[] = [];
  for (const id of objetivo) {
    if (!(await tool("clasificar_correo", { mensajeId: id }))) { say(`No encontré ${id}.`); continue; }
    await tool("extraer_datos_contrato", { mensajeId: id });
    const ev = await tool("validar_operacion", { mensajeId: id });
    const malos = ev.controles.filter((c: { resultado: string }) => c.resultado !== "OK").map((c: { resultado: string; id: string; control: string; detalle: string }) => `${c.resultado === "BLOQUEO" ? "✗" : "!"} ${c.id} ${c.control}: ${c.detalle}`);
    if (objetivo.length === 1) {
      say(`**${id}** (${ev.tipo}) → ${ev.decision}${malos.length ? "\n" + malos.join("\n") : "\nTodos los controles OK."}`);
      if (ev.decision === "REGISTRAR" || ev.decision === "ACTUALIZAR" || (ev.decision === "REQUIERE_REVISION" && !ev.camposFaltantes.length))
        return fin({ toolUseId: `reglas-${id}`, nombre: "registrar_en_maestro", input: { mensajeId: id }, resultadosPrevios: [] });
      const a = await tool("archivar_documento", { mensajeId: id });
      say(ev.decision === "REQUIERE_REVISION" ? `No se puede proponer la escritura: faltan ${ev.camposFaltantes.join(", ")}. Se archivó en \`${a?.ruta}\` hasta que un humano complete los datos (en modo LLM puedes dictarlos en el chat).` : `No se escribe en el maestro. Documento archivado en \`${a?.ruta}\`.`);
    } else filas.push(`| ${id} | ${ev.tipo} | ${ev.decision} | ${Math.round(ev.confianza * 100)} % | ${malos.length ? malos.map((m: string) => m.split(":")[0]).join(", ") : "—"} |`);
  }
  if (filas.length) say(`| Mensaje | Tipo | Decisión | Confianza | Hallazgos |\n|---|---|---|---|---|\n${filas.join("\n")}\n\nPara escribir en el maestro procesa cada mensaje por separado (requiere tu confirmación).`);
  return fin();
}
