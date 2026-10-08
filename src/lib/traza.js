// Resumen legible de lo que recuperó la herramienta de calendario (para la traza de la CLI y las capturas).
const texto = (m) => (typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? ""));

/** @returns {string|null} p. ej. "hibrida | 0.403 retiro de asignaturas 2026-1 | 0.360 ..." */
export function resumenRecuperacion(update, max = 3) {
  for (const m of update?.messages ?? []) {
    if (m?.name !== "buscar_calendario_duoc") continue;
    try {
      const r = JSON.parse(texto(m));
      const filas = (r.resultados ?? []).slice(0, max).map((x) => (x.similitud != null ? `${x.similitud.toFixed(3)} ${x.actividad}` : x.actividad));
      const total = r.resultados?.length ?? 0;
      return `${r.recuperacion ?? "?"} | ${total} resultado(s)${filas.length ? ` | ${filas.join(" | ")}` : ""}`;
    } catch {
      return null;
    }
  }
  return null;
}
