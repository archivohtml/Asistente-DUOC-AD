// Ejecuta la batería de casos contra el agente, mide cada turno y califica la respuesta.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { crearGrafo, conversar } from "../agent/grafo.js";
import { PerfilStore } from "../memory/perfilStore.js";
import { crearHerramientas } from "../tools/index.js";
import { calificar } from "./metricas.js";

export function cargarCasos(archivo = "evaluacion/casos.json") {
  return JSON.parse(fs.readFileSync(archivo, "utf8"));
}

/**
 * @param {object} o { llm, plannerLLM, registrador, casos, repeticiones, recuperador?, hoy?, alTerminar?(caso, rep, resultado) }
 */
export async function ejecutarEvaluacion({ llm, plannerLLM = llm, registrador, casos, repeticiones = 3, recuperador, hoy, alTerminar }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duoc-eval-"));
  const resultados = [];
  for (const caso of casos) {
    for (let rep = 1; rep <= repeticiones; rep++) {
      // Cada ejecución usa un usuario y un perfil nuevos, para que no se contaminen entre sí.
      const usuarioId = `eval-${caso.id}-${rep}`;
      const store = new PerfilStore(path.join(dir, `${usuarioId}.json`));
      if (caso.perfil) store.guardar(usuarioId, caso.perfil);
      const tools = crearHerramientas({ store, recuperador, carpetaSalidas: path.join(dir, "salidas") });
      const grafo = crearGrafo({ llm, plannerLLM, store, tools, ...(hoy ? { hoy: () => hoy } : {}) });

      let respuesta = null;
      try {
        for (const texto of caso.turnos) {
          respuesta = await conversar(grafo, { usuarioId, texto, registrador, meta: { caso: caso.id, tipo: caso.tipo, rep } });
        }
      } catch (e) {
        respuesta = null;
      }
      const turno = registrador.ultimo;
      const cal = respuesta == null
        ? { ok: false, motivo: "el agente lanzó un error", fechas_inventadas: [], fechas: [] }
        : calificar(caso, respuesta, { hoy, preguntas: caso.turnos });
      registrador.anotar(turno.turno_id, { caso: caso.id, tipo: caso.tipo, rep, ok: cal.ok, motivo: cal.motivo, fechas_inventadas: cal.fechas_inventadas });
      const r = { caso: caso.id, tipo: caso.tipo, rep, ...cal, latencia_ms: turno.latencia_ms };
      resultados.push(r);
      alTerminar?.(caso, rep, r);
    }
  }
  return resultados;
}