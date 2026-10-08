// Utilidades de fecha puras (sin dependencias). Formato institucional: dd-mm-yyyy.
const MS_DIA = 86_400_000;

export const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
];

/** "dd-mm-yyyy" -> Date (UTC, medianoche). Devuelve null si es inválida. */
export function parseFecha(texto) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(texto).trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  const valida =
    date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
  return valida ? date : null;
}

/** Date -> "dd-mm-yyyy" */
export function formatFecha(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getUTCDate())}-${p(date.getUTCMonth() + 1)}-${date.getUTCFullYear()}`;
}

/** Date -> "yyyy-mm-dd" */
export function toISO(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * "Hoy" del agente. FECHA_SIMULADA=yyyy-mm-dd permite demos y pruebas deterministas.
 */
export function hoyActual(env = process.env) {
  const sim = env.FECHA_SIMULADA;
  if (sim && /^\d{4}-\d{2}-\d{2}$/.test(sim)) {
    const [y, m, d] = sim.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
}

export function diffDias(a, b) {
  return Math.round((a.getTime() - b.getTime()) / MS_DIA);
}

/**
 * Estado de una actividad respecto de "hoy".
 * Devuelve { estado, dias_para_inicio, dias_para_termino }
 *  estado: "finalizada" | "en_curso" | "por_comenzar"
 */
export function estadoActividad({ inicio, termino }, hoy = hoyActual()) {
  const i = parseFecha(inicio);
  const t = parseFecha(termino);
  if (!i || !t) return { estado: "desconocido", dias_para_inicio: null, dias_para_termino: null };
  const dias_para_inicio = diffDias(i, hoy);
  const dias_para_termino = diffDias(t, hoy);
  let estado = "en_curso";
  if (dias_para_termino < 0) estado = "finalizada";
  else if (dias_para_inicio > 0) estado = "por_comenzar";
  return { estado, dias_para_inicio, dias_para_termino };
}

/**
 * Extrae fechas mencionadas en un texto libre.
 * Soporta "dd-mm-yyyy", "dd/mm/yyyy" y "12 de enero (de 2026)".
 * Devuelve [{ dia, mes, anio|null, texto }]
 */
export function extraerFechas(texto) {
  const out = [];
  const s = String(texto ?? "");
  for (const m of s.matchAll(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/g)) {
    out.push({ dia: +m[1], mes: +m[2], anio: +m[3], texto: m[0] });
  }
  const re = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${MESES.join("|")})(?:\\s+(?:de|del)\\s+(\\d{4}))?`, "gi");
  for (const m of s.matchAll(re)) {
    out.push({
      dia: +m[1],
      mes: MESES.indexOf(m[2].toLowerCase()) + 1,
      anio: m[3] ? +m[3] : null,
      texto: m[0]
    });
  }
  return out;
}
