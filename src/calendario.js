// Motor de búsqueda sobre los calendarios oficiales 2026 (base/presencial y online).
// Recuperación por palabras clave sobre datos estructurados (ver README: decisión de diseño).
import { baseRecords, onlineRecords } from "./data/registros.js";
import { estadoActividad, hoyActual } from "./lib/fechas.js";

export function normalize(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectMode(query, modalidad = "") {
  const text = `${normalize(query)} ${normalize(modalidad)}`;
  if (/online|virtual|en linea/.test(text)) return "online";
  if (/base|presencial|presenciales|precencial|precenciales|presensial|presensiales/.test(text)) {
    return "base/presencial";
  }
  return "";
}

const STOPWORDS = new Set([
  "cuando", "cual", "cuales", "que", "las", "los", "del", "para", "una", "uno", "por",
  "como", "puedes", "quiero", "saber", "fecha", "fechas", "hay", "son", "hasta", "puedo"
]);

const withMeta = (records, modalidad, fuente) => records.map((r) => ({ ...r, modalidad, fuente }));

export const allRecords = [
  ...withMeta(baseRecords, "base/presencial", "Calendario Académico 2026 — Instituto Profesional Duoc UC (Semestral)"),
  ...withMeta(onlineRecords, "online", "Calendario Académico 2026 — Modalidad Online (Bimestral)")
];

export function esSemanaCero(q) {
  return ["semana cero", "semana 0", "semestre cero", "semana-0"].some((k) => q.includes(k));
}

export function enriquecer(record, hoy) {
  const { estado, dias_para_inicio, dias_para_termino } = estadoActividad(record, hoy);
  return { ...record, estado, dias_para_inicio, dias_para_termino };
}

/** Devuelve [{record, score}] ordenado, sin filtrar por modalidad si mode es "". */
export function puntuar(normalizedQuery, mode) {
  const tokens = normalizedQuery
    .split(" ")
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const records = mode ? allRecords.filter((r) => r.modalidad === mode) : allRecords;
  return records
    .map((record) => {
      const text = normalize(`${record.actividad} ${record.aliases}`);
      const score = tokens.reduce((acc, tk) => acc + (text.includes(tk) ? 1 : 0), 0);
      return { record, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

/**
 * ¿Hay que preguntar la modalidad? Solo si la consulta no la indica Y el mejor resultado
 * de cada modalidad tiene fechas distintas (p. ej. feriados iguales no requieren aclaración).
 */
export function necesitaModalidad(query, modalidadConocida = "") {
  if (detectMode(query, modalidadConocida)) return false;
  const nq = normalize(query);
  if (esSemanaCero(nq)) return true;
  const ranked = puntuar(nq, "");
  const mejor = (mod) => ranked.find((x) => x.record.modalidad === mod)?.record;
  const b = mejor("base/presencial");
  const o = mejor("online");
  if (!b || !o) return false;
  return `${b.inicio}|${b.termino}` !== `${o.inicio}|${o.termino}`;
}

export function buscarCalendario({ query = "", modalidad = "", hoy = hoyActual() }) {
  const nq = normalize(query);
  const mode = detectMode(query, modalidad);
  const hoyISO = hoy.toISOString().slice(0, 10);

  if (esSemanaCero(nq)) {
    const semana = allRecords.filter((r) => {
      const t = normalize(`${r.actividad} ${r.aliases}`);
      return t.includes("semana cero") || t.includes("semestre cero");
    });
    const filtrados = mode ? semana.filter((r) => r.modalidad === mode) : semana;
    return {
      query,
      hoy: hoyISO,
      modalidad_consultada: mode || "no especificada",
      resultados: filtrados.map((r) => enriquecer(r, hoy)),
      requiere_aclaracion: !mode && filtrados.length > 1,
      nota: !mode ? "La consulta puede corresponder a base/presencial u online." : null
    };
  }

  const top = puntuar(nq, mode).slice(0, 8).map((x) => enriquecer(x.record, hoy));
  return {
    query,
    hoy: hoyISO,
    modalidad_consultada: mode || "no especificada",
    resultados: top,
    requiere_aclaracion:
      !mode &&
      top.some((r) => r.modalidad === "base/presencial") &&
      top.some((r) => r.modalidad === "online"),
    nota: null
  };
}

/** Hitos que comienzan o terminan dentro de los próximos `dias` días. */
export function proximosHitos({ modalidad = "", dias = 30, hoy = hoyActual() }) {
  const mode = detectMode("", modalidad);
  const records = mode ? allRecords.filter((r) => r.modalidad === mode) : allRecords;
  const resultados = records
    .map((r) => enriquecer(r, hoy))
    .filter(
      (r) =>
        (r.dias_para_inicio >= 0 && r.dias_para_inicio <= dias) ||
        (r.estado === "en_curso" && r.dias_para_termino <= dias)
    )
    .sort((a, b) => Math.min(a.dias_para_termino, 9999) - Math.min(b.dias_para_termino, 9999));
  return {
    hoy: hoy.toISOString().slice(0, 10),
    ventana_dias: dias,
    modalidad_consultada: mode || "no especificada",
    resultados
  };
}
