import "dotenv/config";
import readline from "node:readline";
import { crearGrafo, conversar } from "./agent/grafo.js";
import { crearLLM } from "./agent/llm.js";
import { PerfilStore } from "./memory/perfilStore.js";
import { crearHerramientas } from "./tools/index.js";
import { crearRecuperadorPorDefecto } from "./retrieval/recuperador.js";
import { resumenRecuperacion } from "./lib/traza.js";

const traza = process.argv.includes("--traza") || process.env.TRAZA === "1";
const usuarioId = process.env.USUARIO_ID || "usuario-local";
const store = new PerfilStore();

const llm = crearLLM();
const plannerLLM = process.env.PLANNER_MODEL ? crearLLM({ model: process.env.PLANNER_MODEL, temperature: 0, maxTokens: 400 }) : llm;
const recuperador = crearRecuperadorPorDefecto();
const tools = crearHerramientas({ store, recuperador });
const grafo = crearGrafo({ llm, plannerLLM, store, tools });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

function mostrarTraza(nodo, update) {
  if (nodo === "planificador" && update.plan) {
    const p = update.plan;
    console.log(`  · planificador → ${p.intencion} | modalidad: ${p.modalidad || "?"} | pasos: ${p.pasos.join(" → ")} [${p.origen}]`);
  } else if (nodo === "ejecutor") {
    const calls = update.messages?.[0]?.tool_calls ?? [];
    console.log(calls.length ? `  · ejecutor → llama: ${calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(", ")}` : "  · ejecutor → respuesta final");
  } else if (nodo === "verificador") {
    console.log(update.feedback ? "  · verificador → ⚠ fecha sin respaldo, reintentando" : "  · verificador → ✔ fechas respaldadas");
  } else if (nodo === "replanificador") {
    console.log("  · replanificador → búsqueda vacía, ajustando plan");
  } else if (nodo === "aclaracion") {
    console.log("  · aclaración → falta modalidad");
  } else if (nodo === "herramientas") {
    console.log("  · herramientas → ejecutadas");
    const rec = resumenRecuperacion(update);
    if (rec) console.log(`  · recuperación → ${rec}`);
  }
}

async function main() {
  console.log("Asistente Académico Duoc UC (agente LangGraph)");
  try {
    const { modo, embebidos } = await recuperador.precalentar();
    console.log(`Recuperación: ${modo}${embebidos ? ` (índice creado: ${embebidos} registros embebidos)` : ""}`);
  } catch (e) {
    console.warn(`Recuperación semántica no disponible (${e.message}); se usarán palabras clave.`);
  }
  console.log("Comandos: /perfil  /olvidar  /salir   (ejecuta con --traza para ver el razonamiento)\n");

  while (true) {
    const entrada = (await ask("tú: ")).trim();
    if (!entrada) continue;
    if (["salir", "/salir"].includes(entrada.toLowerCase())) break;
    if (entrada === "/perfil") { console.log(store.obtener(usuarioId), "\n"); continue; }
    if (entrada === "/olvidar") { store.olvidar(usuarioId); console.log("Perfil borrado.\n"); continue; }

    try {
      const respuesta = await conversar(grafo, { usuarioId, texto: entrada, onNodo: traza ? mostrarTraza : undefined });
      console.log(`bot: ${respuesta}\n`);
    } catch (error) {
      console.error("error:", error.message, "\n");
    }
  }
  rl.close();
}

main();
