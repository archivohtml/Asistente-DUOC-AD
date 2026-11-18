// Pruebas de la observabilidad: anonimización, métricas y registro de un turno completo (sin red ni API key).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FECHA_SIMULADA = "2026-10-07";
process.env.SEMANTIC_SEARCH = "off"; // solo palabras clave: sin llamadas de red

import { anonimizarTexto, seudonimo } from "../src/observabilidad/anonimizar.js";
import { calificar, consistencia, fechasDe, percentil, resumir } from "../src/observabilidad/metricas.js";

let deps = null;
try {
  const { AIMessage } = await import("@langchain/core/messages");
  const { BaseChatModel } = await import("@langchain/core/language_models/chat_models");
  const { crearGrafo, conversar } = await import("../src/agent/grafo.js");
  const { Registrador } = await import("../src/observabilidad/registrador.js");
  const { ejecutarEvaluacion } = await import("../src/observabilidad/evaluacion.js");
  deps = { AIMessage, BaseChatModel, crearGrafo, conversar, Registrador, ejecutarEvaluacion };
} catch (e) {
  console.warn("[observabilidad.test] dependencias no instaladas, se omite:", e.code ?? e.message);
}
const opts = { skip: deps ? false : "ejecuta `npm install` para habilitar estas pruebas" };

test("anonimizar: enmascara RUT, correo y teléfono, y seudonimiza al usuario", () => {
  const t = anonimizarTexto("Soy 12.345.678-9, escribe a juan.perez@mail.com o llama al +56 9 8765 4321");
  assert.doesNotMatch(t, /12\.345\.678|juan\.perez|8765/);
  assert.match(t, /\[RUT\].*\[CORREO\].*\[TELEFONO\]/);
  assert.equal(seudonimo("ana"), seudonimo("ana"));
  assert.notEqual(seudonimo("ana"), seudonimo("beto"));
  assert.doesNotMatch(seudonimo("ana"), /ana$/);
});

test("métricas: percentil y consistencia", () => {
  assert.equal(percentil([10, 20, 30, 40, 100], 50), 30);
  assert.equal(percentil([10, 20, 30, 40, 100], 95), 100);
  assert.equal(percentil([], 50), null);
  assert.equal(consistencia(["10-08-2026", "10-08-2026", "11-08-2026"]), 2 / 3);
  assert.equal(consistencia(["solo una"]), null);
});

test("métricas: calificar detecta aciertos, faltantes y fechas inventadas", () => {
  const caso = { esperado: { fechas: ["10-08-2026", "12-09-2026"] } };
  assert.equal(calificar(caso, "Va del 10-08-2026 al 12-09-2026.").ok, true);
  const falta = calificar(caso, "Termina el 12-09-2026.");
  assert.equal(falta.ok, false);
  assert.match(falta.motivo, /10-08-2026/);
  const inv = calificar(caso, "Va del 10-08-2026 al 12-09-2026 y también el 15-04-2026.");
  assert.deepEqual(inv.fechas_inventadas, ["15-04-2026"]);
  assert.equal(inv.ok, false);
  assert.equal(calificar({ esperado: { prohibidas: ["01-01-2026"] } }, "La matrícula es el 01-01-2026").ok, false);
  assert.equal(calificar({ esperado: { sin_fechas: true, menciona: ["online"] } }, "¿Eres base u online?").ok, true);
  assert.deepEqual([...fechasDe("el 5 de mayo de 2026 y el 01-05-2026")].sort(), ["01-05-2026", "05-05-2026"]);
});

/** LLM falso "razonable" (modelo de chat real de LangChain, así emite los mismos eventos que un LLM de verdad):
 *  primero llama a la herramienta; luego responde con las fechas que ella devolvió. */
function llmCoherente() {
  class LLMFalso extends deps.BaseChatModel {
    _llmType() { return "falso"; }
    bindTools() { return this; }
    async _generate(msgs) {
      const ultimo = msgs.at(-1);
      let msg;
      if ((ultimo._getType?.() ?? ultimo.type) === "tool") {
        const r = JSON.parse(ultimo.content).resultados[0];
        msg = new deps.AIMessage({ content: `${r.actividad}: del ${r.inicio} al ${r.termino}.`, usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } });
      } else {
        const pregunta = msgs.filter((m) => (m._getType?.() ?? m.type) === "human").at(-1).content;
        msg = new deps.AIMessage({ content: "", tool_calls: [{ id: "c1", name: "buscar_calendario_duoc", args: { query: pregunta, modalidad: "base" } }], usage_metadata: { input_tokens: 80, output_tokens: 10, total_tokens: 90 } });
      }
      return { generations: [{ text: msg.content, message: msg }] };
    }
  }
  return new LLMFalso({});
}
const planCal = { invoke: async () => new deps.AIMessage(JSON.stringify({ intencion: "calendario", modalidad: "base/presencial", actividad: "retiro de asignaturas", pasos: ["buscar_calendario_duoc"] })) };

test("registrador: un turno deja una línea con latencia, tokens, herramienta y texto anonimizado", opts, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duoc-obs-"));
  const archivo = path.join(dir, "log.jsonl");
  const registrador = new deps.Registrador({ archivo, modelo: "falso" });
  const g = deps.crearGrafo({ llm: llmCoherente(), plannerLLM: planCal });
  await deps.conversar(g, { usuarioId: "u1", texto: "Mi RUT es 12.345.678-9: ¿cuándo es el retiro de asignaturas?", registrador });
  const [linea] = fs.readFileSync(archivo, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(linea.evento, "turno");
  assert.ok(linea.latencia_ms > 0);
  assert.equal(linea.intencion, "calendario");
  assert.deepEqual(linea.nodos.map((n) => n.nodo).slice(0, 3), ["cargar_memoria", "planificador", "ejecutor"]);
  assert.equal(linea.llm.llamadas, 2);
  assert.equal(linea.llm.tokens_in + linea.llm.tokens_out, 210);
  assert.equal(linea.herramientas[0].nombre, "buscar_calendario_duoc");
  assert.ok(linea.recuperacion.n_resultados > 0);
  assert.doesNotMatch(linea.pregunta, /12\.345\.678/);
  assert.match(linea.pregunta, /\[RUT\]/);
  assert.notEqual(linea.usuario, "u1");
});

test("evaluación: ejecuta casos, califica y anota en el log", opts, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duoc-obs-"));
  const archivo = path.join(dir, "log.jsonl");
  const registrador = new deps.Registrador({ archivo, modelo: "falso" });
  const casos = [{ id: "retiro", tipo: "calendario", turnos: ["¿cuándo es el retiro de asignaturas 2026-2?"], esperado: { fechas: ["10-08-2026", "12-09-2026"] } }];
  const res = await deps.ejecutarEvaluacion({ llm: llmCoherente(), plannerLLM: planCal, registrador, casos, repeticiones: 2 });
  assert.equal(res.length, 2);
  const lineas = fs.readFileSync(archivo, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lineas.filter((l) => l.evento === "calificacion").length, 2);
  const r = resumir(lineas);
  assert.equal(r.turnos, 2);
  assert.ok(r.precision >= 0 && r.precision <= 1);
  assert.equal(r.consistencia, 1);
});