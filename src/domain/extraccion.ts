// Extracción determinista con confianza y evidencia por campo. Funciones puras, sin LLM.
// Confianza: 0.95 etiqueta explícita en el documento · 0.75 patrón débil · 0.5 conflicto documento/correo · 0 ausente.

export interface Campo<T> { valor: T | null; confianza: number; evidencia: string | null }
export type TipoDocumento = "CONTRATO" | "OTROSI" | "COTIZACION" | "DESCONOCIDO";

export interface DatosContrato {
  numero: Campo<string>; cliente: Campo<string>; nitCliente: Campo<string>; objeto: Campo<string>;
  valor: Campo<number>; moneda: Campo<string>; fechaInicio: Campo<string>; fechaFin: Campo<string>; fechaFirma: Campo<string>;
}
export interface DatosOtrosi { numeroOtrosi: Campo<string>; contratoBase: Campo<string>; cliente: Campo<string>; nitCliente: Campo<string>; nuevaFechaFin: Campo<string>; valorAdicional: Campo<number>; fechaFirma: Campo<string> }
export interface DatosCotizacion { numero: Campo<string>; cliente: Campo<string>; valor: Campo<number> }

const MESES: Record<string, string> = { enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06", julio: "07", agosto: "08", septiembre: "09", setiembre: "09", octubre: "10", noviembre: "11", diciembre: "12" };

/** "1 de junio de 2026" | "2026-06-01" | "01/06/2026" → "2026-06-01" */
export function parseFecha(s: string): string | null {
  const t = s.trim().toLowerCase();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:de|del)\s+(\d{4})$/); if (m && MESES[m[2]]) return `${m[3]}-${MESES[m[2]]}-${m[1].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

/** Montos en formato colombiano ($480.000.000 o 480.000.000,50) o anglosajón (480,000,000.50). */
export function parseMonto(s: string): number {
  const t = s.replace(/[^\d.,]/g, "");
  const ultimoSep = Math.max(t.lastIndexOf("."), t.lastIndexOf(","));
  if (ultimoSep >= 0 && t.length - ultimoSep - 1 === 2) return Number(t.slice(0, ultimoSep).replace(/[.,]/g, "") + "." + t.slice(ultimoSep + 1));
  return Number(t.replace(/[.,]/g, ""));
}

const FECHA = String.raw`(\d{1,2}\s+de\s+[a-záéíóú]+\s+(?:de|del)\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}/\d{1,2}/\d{4})`;
export const NUM_CONTRATO = /\b([A-Z]{2,4}-\d{4}-\d{3,4})\b/;
const linea = (texto: string, idx: number) => { const ini = texto.lastIndexOf("\n", idx) + 1; const fin = texto.indexOf("\n", idx); return texto.slice(ini, fin < 0 ? undefined : fin).trim().slice(0, 220); };
const vacio = <T>(): Campo<T> => ({ valor: null, confianza: 0, evidencia: null });

function buscar<T>(texto: string, patrones: Array<[RegExp, number]>, conv: (m: RegExpMatchArray) => T | null): Campo<T> {
  for (const [re, conf] of patrones) {
    const m = texto.match(re);
    if (m && m.index !== undefined) { const v = conv(m); if (v !== null && v !== "" && !(typeof v === "number" && !Number.isFinite(v))) return { valor: v, confianza: conf, evidencia: linea(texto, m.index) }; }
  }
  return vacio<T>();
}
const limpio = (s: string) => s.replace(/\s+/g, " ").trim().replace(/(?<![A-Z])[.;]$/, "");
const tituloPropio = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase()
  .replace(/(^|[\s(])([a-záéíóúñ])/g, (_, a, b) => a + b.toUpperCase())
  .replace(/\b(S\.a\.s|S\.a|E\.s\.p)\.?(?=\s|$|,)/gi, (x) => x.replace(/\.?$/, ".").toUpperCase())
  .replace(/\b(De|Del|La|Las|Los|Y)\b(?!$)/g, (x, _p, i) => (i === 0 ? x : x.toLowerCase()));

export function clasificarDocumento(nombreArchivo: string, texto: string): { tipo: TipoDocumento; confianza: number; motivo: string } {
  const n = nombreArchivo.toLowerCase(), t = texto.toLowerCase().slice(0, 600);
  const porNombre: TipoDocumento = /otros/.test(n) ? "OTROSI" : /cotiz|propuesta|oferta/.test(n) ? "COTIZACION" : /contrato/.test(n) ? "CONTRATO" : "DESCONOCIDO";
  const porTexto: TipoDocumento = /^\s*otros[ií]/.test(t) ? "OTROSI" : /cotizaci[oó]n|propuesta econ[oó]mica|oferta comercial|no constituye un contrato/.test(t) ? "COTIZACION" : /contrato de|^\s*contrato/.test(t) ? "CONTRATO" : "DESCONOCIDO";
  if (porNombre === porTexto && porTexto !== "DESCONOCIDO") return { tipo: porTexto, confianza: 0.97, motivo: `Nombre de archivo y encabezado coinciden (${porTexto}).` };
  if (porTexto !== "DESCONOCIDO") return { tipo: porTexto, confianza: 0.85, motivo: `Encabezado del documento indica ${porTexto}${porNombre !== "DESCONOCIDO" ? `; el nombre sugería ${porNombre}` : ""}.` };
  if (porNombre !== "DESCONOCIDO") return { tipo: porNombre, confianza: 0.6, motivo: `Solo el nombre de archivo indica ${porNombre}.` };
  return { tipo: "DESCONOCIDO", confianza: 0.3, motivo: "No se reconoce el tipo de documento." };
}

const parte = (texto: string) => texto.match(/y\s+([^(\n]+?)\s*\(NIT\s*([\d.\-\s]+)\)\s*,?\s*en adelante\s+EL CLIENTE/i);

export function extraerContrato(texto: string): DatosContrato {
  const p = parte(texto);
  const idxP = p?.index ?? 0;
  return {
    numero: buscar(texto, [[/contrato[^\n]{0,60}?\b(?:No\.?|N[°º]|n[uú]mero)\s*([A-Z]{2,4}-\d{4}-\d{3,4})/i, 0.95], [NUM_CONTRATO, 0.75]], (m) => m[1]),
    cliente: p ? { valor: tituloPropio(p[1]), confianza: 0.95, evidencia: linea(texto, idxP) } : buscar(texto, [[/cliente\s*:\s*([^\n(]+)/i, 0.85]], (m) => limpio(m[1])),
    nitCliente: p ? { valor: p[2].replace(/\s/g, ""), confianza: 0.95, evidencia: linea(texto, idxP) } : buscar(texto, [[/cliente[^\n]*NIT\s*([\d.\-]+)/i, 0.8]], (m) => m[1]),
    objeto: buscar(texto, [[/OBJETO\s*[:\-–]\s*([^\n]+)/i, 0.95]], (m) => limpio(m[1])),
    valor: buscar(texto, [[/VALOR\s*[:\-–][^\n$]*\$\s*([\d.,]+)/i, 0.95], [/valor total[^\n$]*\$\s*([\d.,]+)/i, 0.85]], (m) => parseMonto(m[1])),
    moneda: buscar(texto, [[/VALOR\s*[:\-–][^\n]*\b(COP|USD|EUR)\b/i, 0.95], [/\$\s*[\d.,]+\s*(COP|USD|EUR)\b/i, 0.8]], (m) => m[1].toUpperCase()),
    fechaInicio: buscar(texto, [[new RegExp(String.raw`inicia(?:r[aá])?\s+el\s+` + FECHA, "i"), 0.95], [new RegExp(String.raw`fecha de inicio\s*:\s*` + FECHA, "i"), 0.95]], (m) => parseFecha(m[1])),
    fechaFin: buscar(texto, [[new RegExp(String.raw`termina(?:r[aá])?\s+el\s+` + FECHA, "i"), 0.95], [new RegExp(String.raw`(?:fecha de (?:terminaci[oó]n|vencimiento|fin))\s*:\s*` + FECHA, "i"), 0.95]], (m) => parseFecha(m[1])),
    fechaFirma: buscar(texto, [[new RegExp(String.raw`se firma en [^,\n]+,\s*el\s+` + FECHA, "i"), 0.9]], (m) => parseFecha(m[1])),
  };
}

export function extraerOtrosi(texto: string): DatosOtrosi {
  const p = texto.match(/y\s+([^(\n]+?)\s*\(NIT\s*([\d.\-\s]+)\)/i);
  return {
    numeroOtrosi: buscar(texto, [[/OTROS[IÍ]\s+No\.?\s*(\d+)/i, 0.95]], (m) => m[1]),
    contratoBase: buscar(texto, [[/AL CONTRATO[^\n]{0,60}?\b(?:No\.?|N[°º])\s*([A-Z]{2,4}-\d{4}-\d{3,4})/i, 0.95], [NUM_CONTRATO, 0.75]], (m) => m[1]),
    cliente: p ? { valor: tituloPropio(p[1]), confianza: 0.9, evidencia: linea(texto, p.index ?? 0) } : vacio(),
    nitCliente: p ? { valor: p[2].replace(/\s/g, ""), confianza: 0.9, evidencia: linea(texto, p.index ?? 0) } : vacio(),
    nuevaFechaFin: buscar(texto, [[new RegExp(String.raw`prorroga[^\n]*?hasta el\s+` + FECHA, "i"), 0.95]], (m) => parseFecha(m[1])),
    valorAdicional: buscar(texto, [[/adiciona[^\n$]*\$\s*([\d.,]+)/i, 0.95]], (m) => parseMonto(m[1])),
    fechaFirma: buscar(texto, [[new RegExp(String.raw`se firma en [^,\n]+,\s*el\s+` + FECHA, "i"), 0.9]], (m) => parseFecha(m[1])),
  };
}

export function extraerCotizacion(texto: string): DatosCotizacion {
  return {
    numero: buscar(texto, [[/COTIZACI[OÓ]N\s+No\.?\s*([A-Z0-9-]+)/i, 0.9]], (m) => m[1]),
    cliente: buscar(texto, [[/cliente\s*:\s*([^\n(]+)/i, 0.9]], (m) => limpio(m[1])),
    valor: buscar(texto, [[/valor[^\n$]*\$\s*([\d.,]+)/i, 0.85]], (m) => parseMonto(m[1])),
  };
}

/** Señales de instrucciones embebidas en el documento (prompt injection). El contenido es dato, no instrucción. */
export function detectarInstrucciones(texto: string): string[] {
  const pats = [/ignor[ae]\s+(?:las\s+)?instrucciones/i, /ignore (?:all |previous )?instructions/i, /nota para el sistema/i, /system prompt/i, /sin validar/i, /act[uú]a como/i];
  return texto.split("\n").filter((l) => pats.some((p) => p.test(l))).map((l) => l.trim());
}

export const confianzaGlobal = (campos: Record<string, Campo<unknown>>, obligatorios: string[]) => Math.min(...obligatorios.map((k) => campos[k]?.confianza ?? 0));
