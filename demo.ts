// Script de verificación: procesa TODO el buzón llamando a las herramientas directamente, sin LLM.
// Uso: npx tsx demo.ts   |   bun demo.ts   (agrega --json para salida en JSON)
import { ejecutar } from "./src/tools/contratos.js";
import type { Evaluacion } from "./src/domain/controles.js";

const comoJson = process.argv.includes("--json");
const icon = { OK: "✓", ALERTA: "!", BLOQUEO: "✗" } as const;
const resumen: Array<Record<string, unknown>> = [];
const cop = (n: number) => "$" + Math.round(n).toLocaleString("es-CO");

const buzon = (await ejecutar("listar_buzon", {})) as Array<{ id: string; asunto: string }>;
for (const { id, asunto } of buzon) {
  const ex = (await ejecutar("extraer_datos_contrato", { mensajeId: id })) as { campos: Record<string, { valor: unknown; confianza: number }> | null };
  const ev = (await ejecutar("validar_operacion", { mensajeId: id })) as Omit<Evaluacion, "extraccion">;
  let accion: Record<string, unknown>;
  if (ev.decision === "REGISTRAR" || ev.decision === "ACTUALIZAR") {
    // En la demo la confirmación humana se simula como aprobada.
    accion = (await ejecutar("registrar_en_maestro", { mensajeId: id })) as Record<string, unknown>;
  } else {
    // Revisión / duplicado / rechazo: nada se escribe; se archiva en correspondencia.
    accion = (await ejecutar("archivar_documento", { mensajeId: id })) as Record<string, unknown>;
  }
  // Idempotencia: un segundo intento nunca escribe dos veces
  const reintento = (await ejecutar("registrar_en_maestro", { mensajeId: id, justificacion: "Reintento de prueba de idempotencia" })) as Record<string, unknown>;

  resumen.push({ id, tipo: ev.tipo, decision: ev.decision, confianza: ev.confianza, escrito: accion.escrito === true, ruta: accion.archivadoEn ?? accion.ruta ?? null, reintentoEscribe: reintento.escrito === true });
  if (!comoJson) {
    console.log(`\n■ ${id} — ${asunto}\n  Tipo: ${ev.tipo} · Decisión: ${ev.decision} · Confianza: ${Math.round(ev.confianza * 100)} %`);
    if (ex.campos) console.log("  Campos: " + Object.entries(ex.campos).map(([k, c]) => `${k}=${c.valor === null ? "FALTA" : typeof c.valor === "number" && c.valor > 9999 ? cop(c.valor) : c.valor}(${Math.round(c.confianza * 100)}%)`).join(" · "));
    for (const c of ev.controles) console.log(`   ${icon[c.resultado]} ${c.id} ${c.control.padEnd(28)} ${c.detalle}`);
    console.log(accion.escrito ? `  → Maestro actualizado: ${accion.numero}; archivado en ${accion.archivadoEn}` : `  → Sin escritura. Archivado en ${accion.ruta ?? "—"}`);
  }
}

// Caso de revisión humana: msg-005 se completa con datos dados por la persona (simulado)
const revision = (await ejecutar("registrar_en_maestro", { mensajeId: "msg-005", justificacion: "Contrato validado con el área jurídica; valor confirmado por la gerencia comercial", correcciones: { valor: 250000000, comercialCorreo: "diana.vargas@periferia-demo.co" } })) as Record<string, unknown>;
const reporte = (await ejecutar("reporte_vencimientos", {})) as { fechaCorte: string; alertas: Array<{ numero: string; cliente: string; nivel: string; diasRestantes: number }>; totales: Record<string, number> };

if (comoJson) console.log(JSON.stringify({ resumen, revisionMsg005: { escrito: revision.escrito, numero: revision.numero }, vencimientos: reporte }, null, 2));
else {
  console.log("\nResumen del buzón"); console.table(resumen);
  console.log(`Revisión humana msg-005 con justificación y correcciones → ${revision.escrito ? `registrado ${revision.numero}` : `no escrito: ${revision.motivo}`}`);
  console.log(`\nAlertas de vencimiento al ${reporte.fechaCorte} (90 días): ${JSON.stringify(reporte.totales)}`);
  for (const a of reporte.alertas) console.log(`   ${a.nivel.padEnd(8)} ${a.numero} ${a.cliente.padEnd(32)} ${a.diasRestantes} días`);
}
