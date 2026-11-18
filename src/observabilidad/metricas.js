// Cálculo de métricas de observabilidad a partir de los registros (funciones puras, fáciles de probar).
import { extraerFechas, formatFecha, hoyActual } from "../lib/fechas.js";
import { baseRecords, onlineRecords } from "../data/registros.js";

const pad = (n) => String(n).padStart(2, "0");
const iso = (f) => `${pad(f.dia)}-${pad(f.mes)}-${f.anio}`;

/** Conjunto de fechas con año que aparecen en un texto, como "dd-mm-yyyy". */
export function fechasDe(texto) {
  return new Set(extraerFechas(texto).filter((f) => f.anio).map(iso));
}

/** Todas las fechas que existen realmente en el calendario (verdad de referencia). */
export const FECHAS_CALENDARIO = new Set([...baseRecords, ...onlineRecords].flatMap((r) => [r.inicio, r.termino]));

export function percentil(valores, p) {
  const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[i];
}
export const promedio = (v) => {
  const x = v.filter((n) => Number.isFinite(n));
  return x.length ? x.reduce((a, b) => a + b, 0) / x.length : null;
};

/**
 * Califica una respuesta frente al caso de prueba.
 * esperado: { fechas?: [..todas..], grupos?: [[..],[..]] (basta uno completo), prohibidas?, sin_fechas?, menciona?: [regex] }
 * Además detecta fechas INVENTADAS: fechas que no existen en el calendario, ni son "hoy", ni las dijo el estudiante.
 */
export function calificar(caso, respuesta, { hoy = hoyActual(), preguntas = [] } = {}) {
  const e = caso.esperado ?? {};
  const texto = String(respuesta ?? "");
  const fechas = fechasDe(texto);
  const permitidas = new Set([...FECHAS_CALENDARIO, formatFecha(hoy), ...preguntas.flatMap((q) => [...fechasDe(q)])]);
  const inventadas = [...fechas].filter((f) => !permitidas.has(f));
  const motivos = [];

  if (e.fechas?.length) {
    const faltan = e.fechas.filter((f) => !fechas.has(f));
    if (faltan.length) motivos.push(`faltan fechas: ${faltan.join(", ")}`);
  }
  if (e.grupos?.length && !e.grupos.some((g) => g.every((f) => fechas.has(f)))) motivos.push("ningún grupo de fechas esperado está completo");
  if (e.prohibidas?.length) {
    const malas = e.prohibidas.filter((f) => fechas.has(f));
    if (malas.length) motivos.push(`incluye fechas prohibidas: ${malas.join(", ")}`);
  }
  if (e.sin_fechas && fechas.size) motivos.push(`no debía incluir fechas: ${[...fechas].join(", ")}`);
  for (const re of e.menciona ?? []) if (!new RegExp(re, "i").test(texto)) motivos.push(`no menciona /${re}/`);
  if (inventadas.length) motivos.push(`fechas inventadas: ${inventadas.join(", ")}`);

  return { ok: motivos.length === 0, motivo: motivos.join("; "), fechas_inventadas: inventadas, fechas: [...fechas].sort() };
}

/** Consistencia de un caso: % de repeticiones que coinciden con la respuesta más frecuente (mismas fechas). */
export function consistencia(respuestas) {
  if (respuestas.length < 2) return null;
  const claves = respuestas.map((r) => [...fechasDe(r)].sort().join("|"));
  const cuenta = new Map();
  for (const c of claves) cuenta.set(c, (cuenta.get(c) ?? 0) + 1);
  return Math.max(...cuenta.values()) / claves.length;
}

/**
 * Resumen global. `lineas` = objetos leídos del JSONL (eventos "turno" y "calificacion").
 */
export function resumir(lineas) {
  const turnos = lineas.filter((l) => l.evento === "turno");
  const cal = new Map(lineas.filter((l) => l.evento === "calificacion").map((l) => [l.turno_id, l]));
  const calificados = turnos.filter((t) => cal.has(t.turno_id)).map((t) => ({ ...t, ...cal.get(t.turno_id) }));
  const lat = turnos.map((t) => t.latencia_ms);
  const n = turnos.length || 1;

  const porCaso = new Map();
  for (const t of calificados) {
    if (!porCaso.has(t.caso)) porCaso.set(t.caso, []);
    porCaso.get(t.caso).push(t);
  }
  const consist = [...porCaso.values()].map((ts) => consistencia(ts.map((t) => t.respuesta))).filter((c) => c != null);

  return {
    turnos: turnos.length,
    precision: calificados.length ? calificados.filter((t) => t.ok).length / calificados.length : null,
    fechas_inventadas: calificados.filter((t) => t.fechas_inventadas?.length).length,
    consistencia: promedio(consist),
    latencia_ms: { p50: percentil(lat, 50), p95: percentil(lat, 95), promedio: promedio(lat) },
    tokens_por_turno: promedio(turnos.map((t) => t.llm.tokens_in + t.llm.tokens_out)),
    llamadas_llm_por_turno: promedio(turnos.map((t) => t.llm.llamadas)),
    tasas: {
      errores: turnos.filter((t) => t.errores.length).length / n,
      bloqueos_verificador: turnos.filter((t) => t.bloqueos_verificador > 0).length / n,
      mensaje_seguro: turnos.filter((t) => t.mensaje_seguro).length / n,
      replanificacion: turnos.filter((t) => t.replans > 0).length / n,
      aclaracion: turnos.filter((t) => t.aclaracion).length / n
    }
  };
}