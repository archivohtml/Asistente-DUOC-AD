// Pruebas de integración del GRAFO con un LLM simulado (sin red ni API key).
// Requieren `npm install`; si las dependencias no están, se omiten.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FECHA_SIMULADA = "2026-10-07";

let deps = null;
try {
  const { AIMessage } = await import("@langchain/core/messages");
  const { crearGrafo, conversar } = await import("../src/agent/grafo.js");
  const { PerfilStore } = await import("../src/memory/perfilStore.js");
  const { crearHerramientas } = await import("../src/tools/index.js");
  deps = { AIMessage, crearGrafo, conversar, PerfilStore, crearHerramientas };
} catch (e) {
  console.warn("[grafo.test] dependencias no instaladas, se omite:", e.code ?? e.message);
}
const opts = { skip: deps ? false : "ejecuta `npm install` para habilitar estas pruebas" };

/** LLM falso: devuelve respuestas guionadas y registra cuántas veces fue llamado. */
function llmFalso(guion) {
  const llm = {
    llamadas: 0,
    bindTools: () => llm,
    invoke: async (msgs) => {
      llm.llamadas++;
      const paso = guion.shift();
      assert.ok(paso, "el LLM falso se quedó sin respuestas guionadas");
      return paso(msgs);
    }
  };
  return llm;
}
const planFalso = (json) => ({ invoke: async () => new deps.AIMessage(JSON.stringify(json)) });
const PLAN_CAL = { intencion: "calendario", modalidad: null, actividad: "retiro de asignaturas", pasos: ["buscar_calendario_duoc"] };

function entorno() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duoc-g-"));
  const store = new deps.PerfilStore(path.join(dir, "p.json"));
  const tools = deps.crearHerramientas({ store, carpetaSalidas: path.join(dir, "salidas") });
  return { dir, store, tools };
}

test("grafo: sin modalidad conocida pregunta ANTES de gastar una llamada al ejecutor", opts, async () => {
  const { store, tools } = entorno();
  const llm = llmFalso([]);
  const g = deps.crearGrafo({ llm, plannerLLM: planFalso(PLAN_CAL), store, tools });
  const r = await deps.conversar(g, { usuarioId: "u", texto: "¿cuándo es el retiro de asignaturas?" });
  assert.match(r, /base\/presencial.*online/s);
  assert.equal(llm.llamadas, 0);
});

test("grafo: flujo completo plan → tool → respuesta verificada → memoria episódica", opts, async () => {
  const { store, tools } = entorno();
  store.guardar("u", { modalidad: "base" });
  const llm = llmFalso([
    () => new deps.AIMessage({ content: "", tool_calls: [{ id: "c1", name: "buscar_calendario_duoc", args: { query: "retiro de asignaturas", modalidad: "base" } }] }),
    () => new deps.AIMessage("El retiro de asignaturas 2026-2 fue del 10-08-2026 al 12-09-2026 (base/presencial); ya finalizó.")
  ]);
  const nodos = [];
  const g = deps.crearGrafo({ llm, plannerLLM: planFalso(PLAN_CAL), store, tools });
  const r = await deps.conversar(g, { usuarioId: "u", texto: "¿cuándo es el retiro de asignaturas?", onNodo: (n) => nodos.push(n) });
  assert.match(r, /12-09-2026/);
  assert.deepEqual(nodos, ["cargar_memoria", "planificador", "ejecutor", "herramientas", "ejecutor", "verificador", "guardar_memoria"]);
  assert.deepEqual(store.obtener("u").ultimos_temas, ["retiro de asignaturas"]);
});

test("grafo: el verificador bloquea fechas inventadas (reintenta y luego usa mensaje seguro)", opts, async () => {
  const { store, tools } = entorno();
  store.guardar("u", { modalidad: "base" });
  const inventa = () => new deps.AIMessage("El retiro termina el 15-04-2026.");
  const llm = llmFalso([inventa, inventa]);
  const g = deps.crearGrafo({ llm, plannerLLM: planFalso(PLAN_CAL), store, tools });
  const r = await deps.conversar(g, { usuarioId: "u", texto: "¿hasta cuándo puedo retirar un ramo?" });
  assert.doesNotMatch(r, /15-04-2026/);
  assert.match(r, /secretaría académica/);
  assert.equal(llm.llamadas, 2);
});

test("grafo: replanifica una vez si la búsqueda vuelve vacía", opts, async () => {
  const { store, tools } = entorno();
  store.guardar("u", { modalidad: "base" });
  const vacia = () => new deps.AIMessage({ content: "", tool_calls: [{ id: "c1", name: "buscar_calendario_duoc", args: { query: "zzzz qqqq", modalidad: "base" } }] });
  const llm = llmFalso([vacia, () => new deps.AIMessage("No tengo información verificada sobre ese punto en este momento.")]);
  const nodos = [];
  const g = deps.crearGrafo({ llm, plannerLLM: planFalso(PLAN_CAL), store, tools });
  await deps.conversar(g, { usuarioId: "u", texto: "¿cuándo es el zzzz qqqq?", onNodo: (n) => nodos.push(n) });
  assert.ok(nodos.includes("replanificador"));
  assert.equal(nodos.filter((n) => n === "planificador").length, 2);
});

test("grafo: guardar_preferencias escribe memoria de largo plazo y la herramienta de agenda crea un .ics", opts, async () => {
  const { store, tools, dir } = entorno();
  const llm = llmFalso([
    () => new deps.AIMessage({ content: "", tool_calls: [{ id: "c1", name: "guardar_preferencias_estudiante", args: { modalidad: "online", carrera: "Informática" } }] }),
    () => new deps.AIMessage("Listo, guardé tu modalidad."),
  ]);
  const g = deps.crearGrafo({ llm, plannerLLM: planFalso({ intencion: "conversacion", pasos: [] }), store, tools });
  await deps.conversar(g, { usuarioId: "u", texto: "soy de Informática y estudio online" });
  assert.equal(store.obtener("u").modalidad, "online");

  const agenda = tools.find((t) => t.name === "generar_agenda_personal");
  const out = JSON.parse(await agenda.invoke({ consultas: ["exámenes", "retiro de asignaturas"], modalidad: "online", formato: "ics" }, { configurable: { usuario_id: "u" } }));
  assert.equal(out.generado, true);
  assert.match(fs.readFileSync(out.archivo, "utf8"), /BEGIN:VCALENDAR/);
  assert.ok(out.actividades.every((a) => a.estado !== "finalizada"));
  assert.ok(out.archivo.startsWith(dir));
});

test("grafo: si el LLM planificador desvía 'soltar un curso' a derivación, igual se ejecuta la búsqueda", opts, async () => {
  const { store, tools } = entorno();
  store.guardar("u", { modalidad: "base" });
  const PLAN_MALO = { intencion: "derivacion", modalidad: null, actividad: null, pasos: ["explicar_alcance", "derivar_a_funcionario"] };
  const llm = llmFalso([
    () => new deps.AIMessage({ content: "", tool_calls: [{ id: "c1", name: "buscar_calendario_duoc", args: { query: "retiro de asignaturas", modalidad: "base" } }] }),
    () => new deps.AIMessage("Soltar un curso es el retiro de asignaturas 2026-2: del 10-08-2026 al 12-09-2026, ya finalizó.")
  ]);
  const nodos = [];
  const g = deps.crearGrafo({ llm, plannerLLM: planFalso(PLAN_MALO), store, tools });
  const r = await deps.conversar(g, { usuarioId: "u", texto: "quiero soltar un curso", onNodo: (n) => nodos.push(n) });
  assert.ok(nodos.includes("herramientas"), "debe haberse llamado a la herramienta de calendario");
  assert.match(r, /12-09-2026/);
});
