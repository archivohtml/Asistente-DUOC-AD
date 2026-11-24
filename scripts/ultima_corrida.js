// Extrae del log SOLO la última corrida de `npm run evaluar` (desde su primer turno) y la guarda en logs/corrida_final.jsonl.
// Útil cuando logs/ejecuciones.jsonl mezcla varias corridas (pruebas, cortes, reintentos de otras ejecuciones).
//   node scripts/ultima_corrida.js            → imprime el resumen de esa corrida
//   $env:LOG_PATH="logs/corrida_final.jsonl"; npm.cmd run dashboard   → dashboard solo con esa corrida
import fs from "node:fs";
import { cargarCasos } from "../src/observabilidad/evaluacion.js";
import { resumir } from "../src/observabilidad/metricas.js";

const entrada = process.env.LOG_ORIGEN || "logs/ejecuciones.jsonl";
const salida = "logs/corrida_final.jsonl";
const lineas = fs.readFileSync(entrada, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const primero = cargarCasos()[0].id;

// La última corrida empieza en el último turno del primer caso, repetición 1, primer intento.
let inicio = -1;
lineas.forEach((l, i) => {
  if (l.evento === "turno" && l.meta?.caso === primero && l.meta?.rep === 1 && (l.meta?.intento ?? 1) === 1) inicio = i;
});
if (inicio < 0) { console.error(`No encontré el inicio de una corrida (${primero} #1).`); process.exit(1); }

const corrida = lineas.slice(inicio);
fs.writeFileSync(salida, corrida.map((l) => JSON.stringify(l)).join("\n") + "\n");

const r = resumir(corrida);
const pct = (x) => (x == null ? "n/d" : `${(x * 100).toFixed(1)}%`);
const cal = corrida.filter((l) => l.evento === "calificacion");
console.log(`Líneas del log completo: ${lineas.length} | descartadas (corridas anteriores): ${inicio} | usadas: ${corrida.length}
Ejecuciones calificadas (caso × repetición): ${cal.length}   Turnos registrados (los casos de varios turnos cuentan más de uno): ${r.turnos}
Precisión:        ${pct(r.precision)}
Fechas inventadas: ${r.fechas_inventadas}
Consistencia:     ${pct(r.consistencia)}
Latencia p50/p95: ${Math.round(r.latencia_ms.p50)} ms / ${Math.round(r.latencia_ms.p95)} ms
Tokens por turno: ${Math.round(r.tokens_por_turno ?? 0)}   Llamadas LLM por turno: ${r.llamadas_llm_por_turno?.toFixed(2)}
Errores: ${pct(r.tasas.errores)}  Bloqueos: ${pct(r.tasas.bloqueos_verificador)}  Mensaje seguro: ${pct(r.tasas.mensaje_seguro)}  Replan.: ${pct(r.tasas.replanificacion)}  Aclaración: ${pct(r.tasas.aclaracion)}
Guardado en ${salida}`);