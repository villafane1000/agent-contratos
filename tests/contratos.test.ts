// Pruebas de extracción, matriz de controles, maestro y garantías del agente.
// Usan fixtures propios (tests/fixtures) para no depender de los datos oficiales del reto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

process.env.FIXTURES_DIR = fileURLToPath(new URL("./fixtures/reto-02", import.meta.url));
process.env.SIGNING_SECRET = "test-secret";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY_GENERAL;

const { parseFecha, parseMonto, extraerContrato, detectarInstrucciones } = await import("../src/domain/extraccion.js");
const { leerMensaje, comerciales } = await import("../src/data/repo.js");
const { evaluarMensaje } = await import("../src/domain/controles.js");
const { reporteVencimientos } = await import("../src/domain/maestro.js");
const { nuevoMaestro, conMaestro } = await import("../src/tools/contexto.js");
const { ejecutar } = await import("../src/tools/contratos.js");
const { turno } = await import("../src/agent/runtime.js");

const ev = (id: string, m = nuevoMaestro()) => evaluarMensaje(leerMensaje(id), m, comerciales());
const ctl = (id: string, k: string) => ev(id).controles.find((c) => c.id === k)?.resultado;
const enMaestro = <T>(fn: () => Promise<T>, m = nuevoMaestro()) => conMaestro(m, fn);

test("fechas y montos en formato colombiano", () => {
  assert.equal(parseFecha("1 de junio de 2026"), "2026-06-01");
  assert.equal(parseFecha("31/05/2027"), "2027-05-31");
  assert.equal(parseMonto("$480.000.000"), 480000000);
  assert.equal(parseMonto("1.250.000,50"), 1250000.5);
});

test("extracción determinista con confianza y evidencia por campo", () => {
  const d = extraerContrato(leerMensaje("msg-001").adjuntos[0].texto);
  assert.equal(d.numero.valor, "CT-2026-0412");
  assert.equal(d.cliente.valor, "Banco Andino S.A.");
  assert.equal(d.valor.valor, 480000000);
  assert.equal(d.fechaFin.valor, "2027-05-31");
  assert.ok(d.valor.confianza >= 0.9 && d.valor.evidencia?.includes("480.000.000"));
});

test("msg-001 contrato nuevo completo → REGISTRAR", () => assert.equal(ev("msg-001").decision, "REGISTRAR"));
test("msg-002 otrosí sobre contrato existente → ACTUALIZAR", () => assert.equal(ev("msg-002").decision, "ACTUALIZAR"));
test("msg-003 contrato ya registrado → DUPLICADO", () => assert.equal(ev("msg-003").decision, "DUPLICADO"));
test("msg-004 cotización → RECHAZADO por K01", () => { assert.equal(ctl("msg-004", "K01"), "BLOQUEO"); assert.equal(ev("msg-004").decision, "RECHAZADO"); });
test("msg-005 remitente externo y valor faltante → REQUIERE_REVISION", () => {
  assert.equal(ctl("msg-005", "K02"), "ALERTA");
  assert.deepEqual(ev("msg-005").camposFaltantes, ["valor"]);
  assert.equal(ev("msg-005").decision, "REQUIERE_REVISION");
});
test("msg-006 otrosí sin contrato base + inyección → RECHAZADO", () => {
  assert.equal(ctl("msg-006", "K07"), "BLOQUEO");
  assert.equal(ctl("msg-006", "K09"), "ALERTA");
  assert.equal(ev("msg-006").decision, "RECHAZADO");
  assert.ok(detectarInstrucciones(leerMensaje("msg-006").adjuntos[0].texto).length > 0);
});

test("registrar exige decisión válida y es idempotente", async () => {
  const m = nuevoMaestro();
  await enMaestro(async () => {
    const r1 = (await ejecutar("registrar_en_maestro", { mensajeId: "msg-001" })) as { escrito: boolean };
    const r2 = (await ejecutar("registrar_en_maestro", { mensajeId: "msg-001" })) as { escrito: boolean; duplicada: boolean };
    const r3 = (await ejecutar("registrar_en_maestro", { mensajeId: "msg-004" })) as { escrito: boolean };
    assert.equal(r1.escrito, true); assert.equal(r2.escrito, false); assert.equal(r2.duplicada, true); assert.equal(r3.escrito, false);
  }, m);
  assert.ok(m.buscar("CT-2026-0412"));
});

test("otrosí actualiza fecha fin y valor del contrato base", async () => {
  const m = nuevoMaestro();
  await enMaestro(() => ejecutar("registrar_en_maestro", { mensajeId: "msg-002" }), m);
  const r = m.buscar("CT-2025-0187")!;
  assert.equal(r.fechaFin, "2027-06-30");
  assert.equal(r.valor, 660000000);
  // Reprocesar el mismo otrosí ya no es una actualización
  assert.equal(ev("msg-002", m).decision, "DUPLICADO");
});

test("revisión: sin justificación no escribe; con justificación y datos de la persona sí", async () => {
  const m = nuevoMaestro();
  await enMaestro(async () => {
    const a = (await ejecutar("registrar_en_maestro", { mensajeId: "msg-005" })) as { escrito: boolean };
    const b = (await ejecutar("registrar_en_maestro", { mensajeId: "msg-005", justificacion: "Validado con jurídica y gerencia" })) as { escrito: boolean; motivo: string };
    const c = (await ejecutar("registrar_en_maestro", { mensajeId: "msg-005", justificacion: "Validado con jurídica y gerencia", correcciones: { valor: 250000000, comercial: "diana.vargas@periferia-demo.co" } })) as { escrito: boolean };
    assert.equal(a.escrito, false); assert.equal(b.escrito, false); assert.match(b.motivo, /valor/); assert.equal(c.escrito, true);
  }, m);
  assert.equal(m.buscar("CT-2026-0420")?.region, "Costa");
});

test("reporte de vencimientos por niveles", () => {
  const r = reporteVencimientos(nuevoMaestro(), "2026-05-30", 90);
  assert.equal(r.alertas[0].numero, "CT-2024-0102");
  assert.equal(r.alertas[0].nivel, "CRITICA");
  assert.ok(!r.alertas.some((a) => a.numero === "CT-2025-0301")); // fuera del horizonte
});

test("runtime sin LLM: pausa para confirmación y escribe solo al aprobar", async () => {
  const r1 = await turno({ modo: "reglas", messages: [], mensaje: "procesa msg-001" });
  assert.ok(r1.pendiente?.firma && r1.pendiente.resumen);
  assert.equal(r1.estado.operaciones.length, 0);
  const r2 = await turno({ modo: "reglas", messages: [], pendiente: r1.pendiente!, estado: r1.estado, confirmacion: { toolUseId: r1.pendiente!.toolUseId, aprobado: true } });
  assert.equal(r2.estado.operaciones.filter((o) => o.tipo === "ALTA").length, 1);
});

test("rechaza acción pendiente o bitácora alteradas", async () => {
  const r1 = await turno({ modo: "reglas", messages: [], mensaje: "procesa msg-001" });
  const alterada = { ...r1.pendiente!, input: { mensajeId: "msg-004" } };
  await assert.rejects(turno({ modo: "reglas", messages: [], pendiente: alterada, confirmacion: { toolUseId: alterada.toolUseId, aprobado: true } }));
  const r2 = await turno({ modo: "reglas", messages: [], pendiente: r1.pendiente!, estado: r1.estado, confirmacion: { toolUseId: r1.pendiente!.toolUseId, aprobado: true } });
  const ops = structuredClone(r2.estado.operaciones); (ops[0] as { registro: { valor: number } }).registro.valor = 1;
  await assert.rejects(turno({ modo: "reglas", messages: [], mensaje: "consulta el maestro", estado: { operaciones: ops, firma: r2.estado.firma } }));
});

test("entrada inválida a una herramienta se rechaza con zod", async () => {
  await assert.rejects(ejecutar("validar_operacion", { mensajeId: "../etc/passwd" }));
});

test("autoría: el comercial se resuelve por nombre y se rechaza uno fuera del catálogo", async () => {
  const m = nuevoMaestro();
  await enMaestro(async () => {
    const fuera = (await ejecutar("registrar_en_maestro", { mensajeId: "msg-005", justificacion: "Validado con jurídica y gerencia", correcciones: { valor: 250000000, comercial: "victor@gmail.com" } })) as { escrito: boolean; motivo: string };
    assert.equal(fuera.escrito, false); assert.match(fuera.motivo, /catálogo/);
    const lista = (await ejecutar("listar_comerciales", { filtro: "diana" })) as Array<{ correo: string }>;
    assert.equal(lista[0].correo, "diana.vargas@periferia-demo.co");
    const ok = (await ejecutar("registrar_en_maestro", { mensajeId: "msg-005", justificacion: "Validado con jurídica y gerencia", correcciones: { valor: 250000000, comercial: "diana vargas" } })) as { escrito: boolean };
    assert.equal(ok.escrito, true);
  }, m);
  assert.equal(m.buscar("CT-2026-0420")?.comercialCorreo, "diana.vargas@periferia-demo.co");
});

test("correcciones humanas exigen justificación aunque los controles queden en OK", async () => {
  await enMaestro(async () => {
    const r = (await ejecutar("registrar_en_maestro", { mensajeId: "msg-005", correcciones: { valor: 250000000, comercial: "Diana Vargas" } })) as { escrito: boolean; motivo: string };
    assert.equal(r.escrito, false); assert.match(r.motivo, /justificación/);
  });
});
