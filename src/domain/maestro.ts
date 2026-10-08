// "SharePoint" simulado: maestro congelado (CSV) + bitácora de operaciones aprobadas.
// El estado no vive en el servidor: la bitácora viaja firmada (HMAC) con el cliente y se reaplica
// en cada turno (event sourcing ligero). Así funciona igual en funciones serverless sin base de datos.
// En producción el puerto se implementa con Microsoft Graph (listas de SharePoint) sin tocar herramientas.
import type { RegistroContrato } from "../data/repo.js";

interface Base { mensajeId: string; en: string }
export type Operacion =
  | (Base & { tipo: "ALTA"; registro: RegistroContrato; aprobadoPor: string; justificacion?: string })
  | (Base & { tipo: "OTROSI"; numero: string; otrosi: string; cambios: { fechaFin?: string; valorAdicional?: number }; aprobadoPor: string; justificacion?: string })
  | (Base & { tipo: "ARCHIVO"; ruta: string; motivo: string });

export class Maestro {
  private registros = new Map<string, RegistroContrato>();
  readonly operaciones: Operacion[] = [];
  constructor(base: RegistroContrato[], ops: Operacion[] = []) {
    for (const r of base) this.registros.set(r.numero, { ...r, historial: [...(r.historial ?? [])] });
    for (const op of ops) this.aplicar(op);
  }
  buscar(numero: string) { return this.registros.get(numero.trim().toUpperCase()) ?? null; }
  listar() { return [...this.registros.values()]; }
  archivos() { return this.operaciones.filter((o): o is Extract<Operacion, { tipo: "ARCHIVO" }> => o.tipo === "ARCHIVO"); }
  /** Operación ya aplicada para ese mensaje y tipo (idempotencia). */
  previa(mensajeId: string, tipo: Operacion["tipo"]) { return this.operaciones.find((o) => o.mensajeId === mensajeId && o.tipo === tipo) ?? null; }

  aplicar(op: Operacion) {
    if (op.tipo !== "ARCHIVO" && this.previa(op.mensajeId, op.tipo)) return;
    if (op.tipo === "ALTA") {
      if (this.registros.has(op.registro.numero)) throw new Error(`El contrato ${op.registro.numero} ya existe en el maestro`);
      this.registros.set(op.registro.numero, { ...op.registro, historial: [`${op.en.slice(0, 10)} alta desde ${op.mensajeId} (aprobó: ${op.aprobadoPor})`] });
    } else if (op.tipo === "OTROSI") {
      const r = this.registros.get(op.numero);
      if (!r) throw new Error(`No existe el contrato base ${op.numero}`);
      const antes = `fin ${r.fechaFin}, valor ${r.valor}`;
      if (op.cambios.fechaFin) r.fechaFin = op.cambios.fechaFin;
      if (op.cambios.valorAdicional) r.valor += op.cambios.valorAdicional;
      r.estado = "VIGENTE";
      r.historial = [...(r.historial ?? []), `${op.en.slice(0, 10)} otrosí ${op.otrosi} desde ${op.mensajeId}: ${antes} → fin ${r.fechaFin}, valor ${r.valor} (aprobó: ${op.aprobadoPor})`];
    }
    this.operaciones.push(op);
  }
}

const dia = 86_400_000;
export const diasEntre = (desde: string, hasta: string) => Math.round((Date.parse(hasta + "T00:00:00Z") - Date.parse(desde + "T00:00:00Z")) / dia);

export interface AlertaVencimiento { numero: string; cliente: string; fechaFin: string; diasRestantes: number; nivel: "VENCIDO" | "CRITICA" | "ALTA" | "MEDIA"; comercial: string; region: string; valor: number }

/** Reporte de vencimientos: VENCIDO (<0 días y marcado vigente), CRÍTICA ≤30, ALTA ≤60, MEDIA ≤90. [AJUSTAR] umbrales del PRD. */
export function reporteVencimientos(m: Maestro, fechaCorte: string, horizonteDias = 90): { fechaCorte: string; horizonteDias: number; alertas: AlertaVencimiento[]; totales: Record<string, number> } {
  const alertas: AlertaVencimiento[] = [];
  for (const r of m.listar()) {
    if (r.estado === "TERMINADO" || r.estado === "VENCIDO") continue;
    const d = diasEntre(fechaCorte, r.fechaFin);
    if (d > horizonteDias) continue;
    alertas.push({ numero: r.numero, cliente: r.cliente, fechaFin: r.fechaFin, diasRestantes: d, nivel: d < 0 ? "VENCIDO" : d <= 30 ? "CRITICA" : d <= 60 ? "ALTA" : "MEDIA", comercial: r.comercialCorreo, region: r.region, valor: r.valor });
  }
  alertas.sort((a, b) => a.diasRestantes - b.diasRestantes);
  const totales = alertas.reduce<Record<string, number>>((acc, a) => ((acc[a.nivel] = (acc[a.nivel] ?? 0) + 1), acc), {});
  return { fechaCorte, horizonteDias, alertas, totales };
}
