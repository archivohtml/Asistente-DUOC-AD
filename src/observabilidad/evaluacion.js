// Ejecuta la batería de casos contra el agente, mide cada turno y califica la respuesta.
//   EVAL_PAUSA_MS      pausa entre ejecuciones (ms). Por defecto 0. Útil con modelos gratuitos (p. ej. 4000).
//   EVAL_REINTENTOS    reintentos ante límite de tasa (429). Por defecto 3.
//   EVAL_ESPERA_MS     espera base antes de reintentar (ms), crece con cada intento. Por defecto 15000.
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

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const esLimiteDeTasa = (e) => /\b429\b|rate.?limit|too many requests/i.test(String(e?.message ?? e));
const resumenError = (e) => String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 160);

/**
 * @param {object} o { llm, plannerLLM, registrador, casos, repeticiones, recuperador?, hoy?, alTerminar?(caso, rep, resultado),
 *                     pausaMs?, reintentos?, esperaMs? }
 */
export async function ejecutarEvaluacion({
  llm, plannerLLM = llm, registrador, casos, repeticiones = 3, recuperador, hoy, alTerminar,
  pausaMs = Number(process.env.EVAL_PAUSA_MS ?? 0),
  reintentos = Number(process.env.EVAL_REINTENTOS ?? 3),
  esperaMs = Number(process.env.EVAL_ESPERA_MS ?? 15000)
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duoc-eval-"));
  const resultados = [];
  for (const caso of casos) {
    for (let rep = 1; rep <= repeticiones; rep++) {
      let respuesta = null;
      let errorMsg = "";
      let intentos = 0;

      // Un intento ejecuta el caso completo con usuario, perfil y memoria nuevos (no se contaminan entre sí).
      for (let intento = 1; intento <= reintentos + 1; intento++) {
        intentos = intento;
        const usuarioId = `eval-${caso.id}-${rep}-${intento}`;
        const store = new PerfilStore(path.join(dir, `${usuarioId}.json`));
        if (caso.perfil) store.guardar(usuarioId, caso.perfil);
        const tools = crearHerramientas({ store, recuperador, carpetaSalidas: path.join(dir, "salidas") });
        const grafo = crearGrafo({ llm, plannerLLM, store, tools, ...(hoy ? { hoy: () => hoy } : {}) });
        try {
          respuesta = null;
          for (const texto of caso.turnos) {
            respuesta = await conversar(grafo, { usuarioId, texto, registrador, meta: { caso: caso.id, tipo: caso.tipo, rep, intento } });
          }
          errorMsg = "";
          break;
        } catch (e) {
          respuesta = null;
          errorMsg = resumenError(e);
          if (!esLimiteDeTasa(e) || intento > reintentos) break;
          await dormir(esperaMs * intento); // espera creciente antes de reintentar
        }
      }

      const turno = registrador.ultimo;
      const cal = respuesta == null
        ? { ok: false, motivo: `el agente lanzó un error: ${errorMsg || "sin detalle"}`, fechas_inventadas: [], fechas: [] }
        : calificar(caso, respuesta, { hoy, preguntas: caso.turnos });
      registrador.anotar(turno.turno_id, { caso: caso.id, tipo: caso.tipo, rep, intentos, ok: cal.ok, motivo: cal.motivo, fechas_inventadas: cal.fechas_inventadas });
      const r = { caso: caso.id, tipo: caso.tipo, rep, intentos, ...cal, latencia_ms: turno.latencia_ms };
      resultados.push(r);
      alTerminar?.(caso, rep, r);
      if (pausaMs > 0) await dormir(pausaMs);
    }
  }
  return resultados;
}