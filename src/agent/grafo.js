// Orquestación del agente con LangGraph.js
//
//  START → cargar_memoria → planificador ─┬─(falta modalidad)→ aclaracion ──────────────┐
//                  ▲                      └→ ejecutor ─┬─(tool_calls)→ herramientas ─┐  │
//                  │                          ▲  ▲     └─(texto)→ verificador ──┐   │  │
//                  └──── replanificador ◄─────┘  │ (búsqueda vacía)             │   │  │
//                                                └──── (fecha sin respaldo) ◄───┘   │  │
//                                                      guardar_memoria ◄───────────┴──┘ → END
import fs from "node:fs/promises";
import { AIMessage, HumanMessage, RemoveMessage, SystemMessage } from "@langchain/core/messages";
import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { detectMode } from "../calendario.js";
import { hoyActual, toISO } from "../lib/fechas.js";
import { PerfilStore } from "../memory/perfilStore.js";
import { crearHerramientas } from "../tools/index.js";
import { EstadoAgente } from "./estado.js";
import {
  PREGUNTA_MODALIDAD,
  extraerJSON,
  normalizarPlan,
  requiereAclaracion
} from "./planificador.js";
import { mensajesDelTurno, textoDe, ventanaPorTurnos } from "./ventana.js";
import { MENSAJE_SEGURO, verificarFechas } from "./verificador.js";

const PROMPT_PLANIFICADOR = `Eres el PLANIFICADOR de un asistente académico de Duoc UC. Lee la conversación y responde SOLO con JSON:
{"intencion": "calendario|agenda|derivacion|conversacion|fuera_ambito",
 "modalidad": "base/presencial|online|null",
 "actividad": "tema consultado en pocas palabras o null",
 "pasos": ["paso1","paso2"]}
- calendario: pregunta por fechas, plazos o trámites regulares del calendario, también en lenguaje coloquial: "dejar/soltar/eliminar un ramo, materia o curso" (= retiro de asignaturas), inscribirse en ramos, pagar la matrícula, exámenes, feriados, la bienvenida de alumnos nuevos. Aunque no diga "fecha", si quiere saber cuándo o hasta cuándo puede hacer algo, es calendario.
- agenda: pide archivo/recordatorios.
- derivacion: SOLO casos individuales que exigen revisión humana (beca, apelación, salud, convalidación, reclamo, situación particular). Ante la duda entre calendario y derivacion de un trámite regular, elige calendario.
- Los seguimientos cortos ("¿y las online?") heredan el tema anterior.
- Pasos posibles: buscar_calendario_duoc, proximos_hitos, interpretar_estado_del_plazo, generar_agenda_personal, guardar_preferencias_estudiante, explicar_alcance, derivar_a_funcionario, responder_con_fuente.`;

let promptBase = "";
async function cargarPrompt() {
  if (!promptBase) promptBase = await fs.readFile(new URL("../prompt.txt", import.meta.url), "utf8");
  return promptBase;
}

export function construirPrompt(plantilla, { perfil, plan, feedback, hoy }) {
  const perfilTxt = Object.keys(perfil ?? {}).length ? JSON.stringify(perfil) : "sin datos todavía";
  return plantilla
    .replace("{{HOY}}", () => toISO(hoy))
    .replace("{{PERFIL}}", () => perfilTxt)
    .replace("{{PLAN}}", () => (plan ? JSON.stringify(plan) : "sin plan"))
    .replace("{{FEEDBACK}}", () => (feedback ? `INSTRUCCIÓN DEL SISTEMA: ${feedback}` : ""));
}

const usuarioDe = (config) => config?.configurable?.usuario_id ?? config?.configurable?.thread_id ?? "usuario-local";
const ultimoHumano = (msgs) => textoDe([...msgs].reverse().find((m) => (m._getType?.() ?? m.type) === "human"));
const esTool = (m) => (m._getType?.() ?? m.type) === "tool";

function ultimaBusquedaVacia(messages) {
  const tools = mensajesDelTurno(messages).filter(esTool);
  const busquedas = tools.filter((m) => m.name === "buscar_calendario_duoc");
  if (!busquedas.length) return false;
  try {
    return JSON.parse(textoDe(busquedas.at(-1))).resultados?.length === 0;
  } catch {
    return false;
  }
}

export function crearGrafo({
  llm,
  plannerLLM = llm,
  store = new PerfilStore(),
  checkpointer = new MemorySaver(),
  tools = crearHerramientas({ store }),
  maxPasosHerramientas = 6,
  hoy = () => hoyActual()
}) {
  const llmConTools = llm.bindTools(tools);

  // 1) MEMORIA DE LARGO PLAZO → estado
  const cargar_memoria = (_s, config) => ({
    perfil: store.obtener(usuarioDe(config)),
    replans: 0,
    reintentos: 0,
    feedback: ""
  });

  // 2) PLANIFICACIÓN (LLM con respaldo heurístico; se adapta si hay replanificación)
  const planificador = async (state, config) => {
    if (state.replans > 0 && state.plan) {
      return {
        plan: { ...state.plan, pasos: [...state.plan.pasos, "reformular_busqueda"], origen: "replan" },
        feedback:
          "La búsqueda anterior no devolvió resultados. Reformula con palabras clave más simples (p. ej. 'retiro asignaturas'), " +
          "prueba sin modalidad o pregunta al estudiante qué actividad busca. No inventes fechas."
      };
    }
    const mensaje = ultimoHumano(state.messages);
    const ctx = { mensaje, modalidadPerfil: detectMode(state.perfil?.modalidad ?? ""), intencionPrevia: state.plan?.intencion ?? null };
    let crudo = null;
    try {
      const recientes = ventanaPorTurnos(state.messages, 3)
        .filter((m) => !esTool(m) && textoDe(m))
        .map((m) => ({ role: (m._getType?.() ?? m.type) === "human" ? "user" : "assistant", content: textoDe(m) }));
      const r = await plannerLLM.invoke([new SystemMessage(PROMPT_PLANIFICADOR), ...recientes], config);
      crudo = extraerJSON(textoDe(r));
    } catch {
      crudo = null; // respaldo heurístico
    }
    return { plan: normalizarPlan(crudo, ctx) };
  };

  const decidirTrasPlan = (state) =>
    requiereAclaracion(state.plan, ultimoHumano(state.messages)) ? "aclaracion" : "ejecutor";

  // 2b) Aclaración determinista (sin gastar una llamada al LLM)
  const aclaracion = () => ({ messages: [new AIMessage(PREGUNTA_MODALIDAD)] });

  // 3) EJECUCIÓN: razonamiento + decisión de herramientas (ReAct)
  const ejecutor = async (state, config) => {
    const plantilla = await cargarPrompt();
    const sistema = construirPrompt(plantilla, { ...state, hoy: hoy() });
    const iteraciones = mensajesDelTurno(state.messages).filter((m) => (m._getType?.() ?? m.type) === "ai").length;
    const modelo = iteraciones >= maxPasosHerramientas ? llm : llmConTools; // sin tools fuerza respuesta final
    const respuesta = await modelo.invoke([new SystemMessage(sistema), ...ventanaPorTurnos(state.messages, 8)], config);
    return { messages: [respuesta] };
  };

  const decidirTrasEjecutor = (state) => (state.messages.at(-1)?.tool_calls?.length ? "herramientas" : "verificador");

  const herramientas = new ToolNode(tools);

  const decidirTrasHerramientas = (state) =>
    ultimaBusquedaVacia(state.messages) && state.replans < 1 ? "replanificador" : "ejecutor";
  const replanificador = (state) => ({ replans: state.replans + 1 });

  // 4) VERIFICACIÓN: guardrail determinista contra fechas inventadas
  const verificador = (state) => {
    const ultimo = state.messages.at(-1);
    const turno = mensajesDelTurno(state.messages);
    const permitidos = [...turno.filter(esTool).map(textoDe), ultimoHumano(state.messages)];
    const v = verificarFechas({ respuesta: textoDe(ultimo), textosPermitidos: permitidos, hoy: hoy() });
    if (v.ok) return { feedback: "" };

    const quitar = ultimo.id ? [new RemoveMessage({ id: ultimo.id })] : [];
    if (state.reintentos < 1) {
      return {
        messages: quitar,
        reintentos: state.reintentos + 1,
        feedback:
          `Tu respuesta anterior incluía fechas sin respaldo de las herramientas (${v.fechas_no_respaldadas.join(", ")}). ` +
          "Llama a buscar_calendario_duoc si falta información y responde SOLO con fechas devueltas por las herramientas."
      };
    }
    return { messages: [...quitar, new AIMessage(MENSAJE_SEGURO)], feedback: "" };
  };
  const decidirTrasVerificador = (state) => (state.feedback ? "ejecutor" : "guardar_memoria");

  // 5) MEMORIA EPISÓDICA: recuerda los temas consultados
  const guardar_memoria = (state, config) => {
    const { intencion, actividad } = state.plan ?? {};
    if (["calendario", "agenda"].includes(intencion)) {
      store.registrarTema(usuarioDe(config), actividad || ultimoHumano(state.messages).slice(0, 60));
    }
    return { feedback: "" }; // devuelve estado para que el nodo aparezca en la traza (streamMode "updates")
  };

  return new StateGraph(EstadoAgente)
    .addNode("cargar_memoria", cargar_memoria)
    .addNode("planificador", planificador)
    .addNode("aclaracion", aclaracion)
    .addNode("ejecutor", ejecutor)
    .addNode("herramientas", herramientas)
    .addNode("replanificador", replanificador)
    .addNode("verificador", verificador)
    .addNode("guardar_memoria", guardar_memoria)
    .addEdge(START, "cargar_memoria")
    .addEdge("cargar_memoria", "planificador")
    .addConditionalEdges("planificador", decidirTrasPlan, ["aclaracion", "ejecutor"])
    .addEdge("aclaracion", "guardar_memoria")
    .addConditionalEdges("ejecutor", decidirTrasEjecutor, ["herramientas", "verificador"])
    .addConditionalEdges("herramientas", decidirTrasHerramientas, ["replanificador", "ejecutor"])
    .addEdge("replanificador", "planificador")
    .addConditionalEdges("verificador", decidirTrasVerificador, ["ejecutor", "guardar_memoria"])
    .addEdge("guardar_memoria", END)
    .compile({ checkpointer });
}

/**
 * Envía un mensaje al agente. `onNodo(nombre, actualizacion)` permite mostrar la traza de orquestación.
 */
export async function conversar(grafo, { usuarioId = "usuario-local", texto, onNodo }) {
  const config = { configurable: { thread_id: usuarioId, usuario_id: usuarioId }, recursionLimit: 40 };
  const flujo = await grafo.stream({ messages: [new HumanMessage(texto)] }, { ...config, streamMode: "updates" });
  for await (const chunk of flujo) {
    for (const [nodo, update] of Object.entries(chunk)) onNodo?.(nodo, update ?? {});
  }
  const estado = await grafo.getState(config);
  const ultimo = [...estado.values.messages].reverse().find((m) => (m._getType?.() ?? m.type) === "ai" && textoDe(m));
  return textoDe(ultimo) || "No pude generar una respuesta en este momento.";
}
