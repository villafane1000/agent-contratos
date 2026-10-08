// Matriz de controles: decide qué hacer con cada mensaje. Funciones puras: ninguna decisión depende del LLM.
// [AJUSTAR] umbral, campos obligatorios y reglas exactas según el PRD oficial.
import type { Comercial, Mensaje, RegistroContrato } from "../data/repo.js";
import { clasificarDocumento, extraerContrato, extraerOtrosi, extraerCotizacion, detectarInstrucciones, confianzaGlobal, NUM_CONTRATO, type TipoDocumento, type DatosContrato, type DatosOtrosi, type DatosCotizacion, type Campo } from "./extraccion.js";
import { diasEntre, type Maestro } from "./maestro.js";

export const UMBRAL_CONFIANZA = Number(process.env.UMBRAL_CONFIANZA ?? 0.85);
export const OBLIGATORIOS_CONTRATO = ["numero", "cliente", "nitCliente", "objeto", "valor", "fechaInicio", "fechaFin"] as const;

export type Resultado = "OK" | "ALERTA" | "BLOQUEO";
export interface Control { id: string; control: string; resultado: Resultado; detalle: string }
export type Decision = "REGISTRAR" | "ACTUALIZAR" | "REQUIERE_REVISION" | "DUPLICADO" | "RECHAZADO";

export interface Evaluacion {
  mensajeId: string; asunto: string; remitente: string;
  tipo: TipoDocumento; documento: string | null; operacion: "ALTA" | "OTROSI" | "NINGUNA";
  decision: Decision; confianza: number; controles: Control[];
  autoria: { correo: string; nombre: string | null; region: string | null; enCatalogo: boolean };
  extraccion: DatosContrato | DatosOtrosi | DatosCotizacion | null;
  /** Registro que se daría de alta (ALTA) o cambios sobre el maestro (OTROSI). */
  propuesta: { registro?: RegistroContrato; numero?: string; otrosi?: string; cambios?: { fechaFin?: string; valorAdicional?: number }; antes?: { fechaFin: string; valor: number } } | null;
  camposFaltantes: string[];
  carpetaArchivo: string;
}

export interface Correcciones { valor?: number; comercialCorreo?: string; fechaInicio?: string; fechaFin?: string; objeto?: string }

const val = <T>(c: Campo<T> | undefined) => c?.valor ?? null;
const pct = (n: number) => `${Math.round(n * 100)} %`;

export function evaluarMensaje(msg: Mensaje, maestro: Maestro, catalogo: Comercial[], corr: Correcciones = {}): Evaluacion {
  const c: Control[] = [];
  const add = (id: string, control: string, resultado: Resultado, detalle: string) => c.push({ id, control, resultado, detalle });
  const { correo } = msg;

  // Documento principal: el primer adjunto reconocible
  const docs = msg.adjuntos.map((a) => ({ ...a, cls: clasificarDocumento(a.nombre, a.texto) }));
  const doc = docs.find((d) => d.cls.tipo !== "DESCONOCIDO") ?? docs[0] ?? null;
  const tipo: TipoDocumento = doc?.cls.tipo ?? "DESCONOCIDO";

  // K01 Tipo documental
  if (!doc) add("K01", "Tipo documental", "BLOQUEO", "El correo no trae documento adjunto.");
  else if (tipo === "COTIZACION") add("K01", "Tipo documental", "BLOQUEO", "Es una cotización/propuesta, no un contrato firmado: no se registra en el maestro.");
  else if (tipo === "DESCONOCIDO") add("K01", "Tipo documental", "BLOQUEO", `No se reconoce ${doc.nombre} como contrato u otrosí.`);
  else add("K01", "Tipo documental", doc.cls.confianza >= UMBRAL_CONFIANZA ? "OK" : "ALERTA", `${tipo} (${pct(doc.cls.confianza)}): ${doc.cls.motivo}`);

  // K02 Autoría comercial
  const correoAutor = (corr.comercialCorreo ?? correo.de).toLowerCase().trim();
  const com = catalogo.find((x) => x.correo.toLowerCase() === correoAutor) ?? null;
  const autoria = { correo: correoAutor, nombre: com?.nombre ?? null, region: com?.region ?? null, enCatalogo: !!com };
  if (com) add("K02", "Autoría comercial", "OK", `${com.nombre} (${com.region})${corr.comercialCorreo ? " — asignado por corrección humana" : ""}.`);
  else add("K02", "Autoría comercial", "ALERTA", `El remitente ${correo.de} no está en el catálogo de comerciales: la autoría y la región deben asignarse manualmente.`);

  // K09 Instrucciones embebidas (se evalúa para todos los tipos)
  const inyeccion = msg.adjuntos.flatMap((a) => detectarInstrucciones(a.texto)).concat(detectarInstrucciones(correo.cuerpo));
  const k09 = () => inyeccion.length
    ? add("K09", "Contenido sospechoso", "ALERTA", `El documento contiene instrucciones dirigidas al sistema; se ignoraron: "${inyeccion[0].slice(0, 120)}"`)
    : add("K09", "Contenido sospechoso", "OK", "Sin instrucciones embebidas.");

  const numerosCorreo = [...`${correo.asunto}\n${correo.cuerpo}`.matchAll(new RegExp(NUM_CONTRATO, "g"))].map((m) => m[1]);
  let extraccion: Evaluacion["extraccion"] = null, propuesta: Evaluacion["propuesta"] = null, operacion: Evaluacion["operacion"] = "NINGUNA";
  let camposFaltantes: string[] = [], confianza = doc?.cls.confianza ?? 0, duplicado = false;

  if (doc && tipo === "CONTRATO") {
    const d = extraerContrato(doc.texto);
    // Correcciones humanas explícitas: confianza 1, evidencia = la persona que aprueba
    for (const k of ["valor", "fechaInicio", "fechaFin", "objeto"] as const) if (corr[k] !== undefined) (d[k] as Campo<unknown>) = { valor: corr[k], confianza: 1, evidencia: "Corrección humana en la confirmación" };
    extraccion = d; operacion = "ALTA";
    camposFaltantes = OBLIGATORIOS_CONTRATO.filter((k) => d[k].valor === null);
    const presentes = OBLIGATORIOS_CONTRATO.filter((k) => d[k].valor !== null);
    confianza = presentes.length ? Math.min(confianza, confianzaGlobal(d as unknown as Record<string, Campo<unknown>>, presentes)) : 0;
    add("K03", "Campos obligatorios", camposFaltantes.length ? "ALERTA" : "OK", camposFaltantes.length ? `Faltan: ${camposFaltantes.join(", ")}. No se inventan valores.` : "Completos.");
    add("K04", "Confianza de extracción", confianza >= UMBRAL_CONFIANZA ? "OK" : "ALERTA", `Mínima por campo extraído ${pct(confianza)} (umbral ${pct(UMBRAL_CONFIANZA)}).`);
    const ini = val(d.fechaInicio), fin = val(d.fechaFin);
    if (ini && fin) add("K05", "Coherencia de fechas", diasEntre(ini, fin) > 0 ? "OK" : "BLOQUEO", `Vigencia ${ini} → ${fin} (${diasEntre(ini, fin)} días).`);
    else add("K05", "Coherencia de fechas", "ALERTA", "No hay fechas completas para validar la vigencia.");
    if (fin && diasEntre(correo.fecha.slice(0, 10), fin) < 0) add("K10", "Vigencia al recibir", "ALERTA", `El contrato ya estaba vencido al recibir el correo (${fin}).`);
    const numero = val(d.numero);
    const existente = numero ? maestro.buscar(numero) : null;
    if (existente) {
      const igual = existente.nitCliente.replace(/\D/g, "") === (val(d.nitCliente) ?? "").replace(/\D/g, "") && existente.valor === val(d.valor) && existente.fechaFin === fin;
      duplicado = igual;
      add("K06", "Duplicados", "BLOQUEO", igual ? `${numero} ya está en el maestro con los mismos datos (origen: ${existente.origen ?? "maestro"}). No se vuelve a registrar.` : `${numero} ya existe con datos distintos (maestro: valor ${existente.valor}, fin ${existente.fechaFin}). Posible conflicto: si es una modificación debe llegar como otrosí.`);
    } else add("K06", "Duplicados", "OK", numero ? `${numero} no existe en el maestro.` : "Sin número para comparar.");
    const otros = numerosCorreo.filter((n) => n !== numero);
    add("K08", "Coherencia correo/documento", !numerosCorreo.length || !otros.length ? "OK" : "ALERTA", !numerosCorreo.length ? "El correo no cita número; se usa el del documento." : !otros.length ? `El correo cita ${numero}, igual que el documento.` : `El correo cita ${otros.join(", ")} pero el documento dice ${numero}.`);
    k09();
    if (numero && camposFaltantes.length === 0)
      propuesta = { registro: { numero, cliente: val(d.cliente)!, nitCliente: val(d.nitCliente)!, objeto: val(d.objeto)!, valor: val(d.valor)!, moneda: val(d.moneda) ?? "COP", fechaInicio: ini!, fechaFin: fin!, comercialCorreo: autoria.correo, region: autoria.region ?? "SIN ASIGNAR", estado: "VIGENTE", rutaDocumento: `/Contratos/${ini!.slice(0, 4)}/${numero}/${doc.nombre}`, origen: msg.id } };
  } else if (doc && tipo === "OTROSI") {
    const d = extraerOtrosi(doc.texto);
    extraccion = d; operacion = "OTROSI";
    const base = val(d.contratoBase), nuevaFin = val(d.nuevaFechaFin), adicion = val(d.valorAdicional);
    camposFaltantes = [...(base ? [] : ["contratoBase"]), ...(nuevaFin || adicion ? [] : ["nuevaFechaFin|valorAdicional"])];
    const usados = ["contratoBase", ...(nuevaFin ? ["nuevaFechaFin"] : []), ...(adicion ? ["valorAdicional"] : [])];
    confianza = Math.min(confianza, confianzaGlobal(d as unknown as Record<string, Campo<unknown>>, usados));
    add("K03", "Campos obligatorios", camposFaltantes.length ? "ALERTA" : "OK", camposFaltantes.length ? `Faltan: ${camposFaltantes.join(", ")}.` : `Contrato base ${base}; cambios: ${[nuevaFin && "prórroga", adicion && "adición"].filter(Boolean).join(" y ")}.`);
    add("K04", "Confianza de extracción", confianza >= UMBRAL_CONFIANZA ? "OK" : "ALERTA", `Mínima por campo ${pct(confianza)} (umbral ${pct(UMBRAL_CONFIANZA)}).`);
    const r = base ? maestro.buscar(base) : null;
    if (!r) add("K07", "Contrato base", "BLOQUEO", `El contrato base ${base ?? "?"} no existe en el maestro: un otrosí no puede crear contratos.`);
    else {
      const nitOk = !val(d.nitCliente) || r.nitCliente.replace(/\D/g, "") === val(d.nitCliente)!.replace(/\D/g, "");
      add("K07", "Contrato base", nitOk ? "OK" : "ALERTA", nitOk ? `${base} existe (${r.cliente}, fin actual ${r.fechaFin}).` : `El NIT del otrosí (${val(d.nitCliente)}) no coincide con el del maestro (${r.nitCliente}).`);
      const ya = (r.historial ?? []).some((h) => h.includes(`otrosí ${val(d.numeroOtrosi)} `));
      if (ya) { duplicado = true; add("K06", "Duplicados", "BLOQUEO", `El otrosí ${val(d.numeroOtrosi)} ya fue aplicado a ${base}.`); }
      else add("K06", "Duplicados", "OK", "Otrosí no aplicado previamente.");
    }
    if (nuevaFin && !duplicado) {
      const ref = r?.fechaFin;
      add("K05", "Coherencia de fechas", ref && diasEntre(ref, nuevaFin) <= 0 ? "BLOQUEO" : diasEntre(correo.fecha.slice(0, 10), nuevaFin) < 0 ? "BLOQUEO" : "OK",
        ref && diasEntre(ref, nuevaFin) <= 0 ? `La prórroga (${nuevaFin}) no es posterior al fin actual (${ref}).` : diasEntre(correo.fecha.slice(0, 10), nuevaFin) < 0 ? `La nueva fecha fin ${nuevaFin} ya pasó.` : `Prórroga ${ref ?? "?"} → ${nuevaFin}.`);
    }
    add("K08", "Coherencia correo/documento", !numerosCorreo.length || numerosCorreo.includes(base ?? "") ? "OK" : "ALERTA", !numerosCorreo.length ? "El correo no cita número." : numerosCorreo.includes(base ?? "") ? `El correo cita ${base}, igual que el otrosí.` : `El correo cita ${numerosCorreo.join(", ")} y el otrosí ${base}.`);
    k09();
    if (r && base) propuesta = { numero: base, otrosi: val(d.numeroOtrosi) ?? "?", cambios: { ...(nuevaFin ? { fechaFin: nuevaFin } : {}), ...(adicion ? { valorAdicional: adicion } : {}) }, antes: { fechaFin: r.fechaFin, valor: r.valor } };
  } else if (doc && tipo === "COTIZACION") {
    extraccion = extraerCotizacion(doc.texto);
    k09();
  } else k09();

  const bloqueos = c.filter((x) => x.resultado === "BLOQUEO"), alertas = c.filter((x) => x.resultado === "ALERTA");
  const decision: Decision = duplicado && bloqueos.every((b) => b.id === "K06") ? "DUPLICADO" : bloqueos.length ? "RECHAZADO" : alertas.length ? "REQUIERE_REVISION" : operacion === "OTROSI" ? "ACTUALIZAR" : "REGISTRAR";
  const carpetaArchivo = decision === "REGISTRAR" || decision === "ACTUALIZAR"
    ? (propuesta?.registro?.rutaDocumento ?? `/Contratos/${maestro.buscar(propuesta?.numero ?? "")?.fechaInicio.slice(0, 4) ?? "sin-año"}/${propuesta?.numero}/otrosi-${propuesta?.otrosi}-${doc?.nombre}`)
    : `/Correspondencia/${{ DUPLICADO: "Duplicados", RECHAZADO: "Rechazados", REQUIERE_REVISION: "En revisión" }[decision]}/${msg.id}/${doc?.nombre ?? "correo.json"}`;
  return { mensajeId: msg.id, asunto: correo.asunto, remitente: correo.de, tipo, documento: doc?.nombre ?? null, operacion, decision, confianza: +confianza.toFixed(2), controles: c.sort((a, b) => a.id.localeCompare(b.id)), autoria, extraccion, propuesta, camposFaltantes, carpetaArchivo };
}
