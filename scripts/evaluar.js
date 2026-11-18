// Ejecuta la batería de evaluación contra el agente REAL (requiere OPENROUTER_API_KEY).
//   npm run evaluar                      → todos los casos × 3 repeticiones
//   npm run evaluar -- --rep=5           → 5 repeticiones (mejor medida de consistencia)
//   npm run evaluar -- --casos=cal_retiro_base,der_beca
import "dotenv/config";
import fs from "node:fs";
import { crearLLM } from "../src/agent/llm.js";
import { crearRecuperadorPorDefecto } from "../src/retrieval/recuperador.js";
import { Registrador } from "../src/observabilidad/registrador.js";
import { cargarCasos, ejecutarEvaluacion } from "../src/observabilidad/evaluacion.js";
import { resumir } from "../src/observabilidad/metricas.js";

const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
const repeticiones = Number(arg("rep", 3));
const filtro = arg("casos", "")?.split(",").filter(Boolean);
const casos = cargarCasos().filter((c) => !filtro.length || filtro.includes(c.id));

const llm = crearLLM();
const plannerLLM = process.env.PLANNER_MODEL ? crearLLM({ model: process.env.PLANNER_MODEL, temperature: 0, maxTokens: 400 }) : llm;
const recuperador = crearRecuperadorPorDefecto();
await recuperador.precalentar().catch(() => {});
const registrador = new Registrador();

console.log(`Evaluando ${casos.length} casos × ${repeticiones} repeticiones...\n`);
await ejecutarEvaluacion({
  llm, plannerLLM, registrador, casos, repeticiones, recuperador,
  alTerminar: (c, rep, r) => console.log(`${r.ok ? "✔" : "✘"} ${c.id} #${rep}  ${Math.round(r.latencia_ms)} ms${r.ok ? "" : "  → " + r.motivo}`)
});

const lineas = fs.readFileSync(registrador.archivo, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const resumen = resumir(lineas);
fs.writeFileSync("logs/resumen.json", JSON.stringify(resumen, null, 2));
const pct = (x) => (x == null ? "n/d" : `${(x * 100).toFixed(1)}%`);
console.log(`\n=== RESUMEN ===
Turnos registrados:     ${resumen.turnos}
Precisión:              ${pct(resumen.precision)}
Fechas inventadas:      ${resumen.fechas_inventadas} respuestas
Consistencia:           ${pct(resumen.consistencia)}
Latencia p50 / p95:     ${Math.round(resumen.latencia_ms.p50)} ms / ${Math.round(resumen.latencia_ms.p95)} ms
Tokens por turno:       ${Math.round(resumen.tokens_por_turno ?? 0)}
Llamadas LLM por turno: ${resumen.llamadas_llm_por_turno?.toFixed(2)}
Errores / bloqueos / mensaje seguro / replan: ${pct(resumen.tasas.errores)} / ${pct(resumen.tasas.bloqueos_verificador)} / ${pct(resumen.tasas.mensaje_seguro)} / ${pct(resumen.tasas.replanificacion)}
\nSiguiente paso: npm run dashboard`);