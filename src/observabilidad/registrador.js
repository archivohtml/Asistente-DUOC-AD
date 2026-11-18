// Observabilidad: registra UNA línea JSON por turno en logs/ejecuciones.jsonl.
// Mide latencia (total y por nodo), tokens, llamadas al LLM, herramientas, errores y decisiones del agente.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { anonimizarTexto, seudonimo } from "./anonimizar.js";
import { MENSAJE_SEGURO } from "../agent/verificador.js";

const ahora = () => performance.now();
const redondear = (n) => Math.round(n * 10) / 10;

/** Callback de LangChain: captura cada llamada al LLM y a las herramientas del turno. */
class Medidor extends BaseCallbackHandler {
  name = "medidor_observabilidad";
  constructor(turno) {
    super();
    this.awaitHandlers = true; // espera a que cada evento se registre antes de seguir
    this.t = turno;
    this.inicio = new Map();
  }
  handleChatModelStart(_llm, _msgs, runId) { this.inicio.set(runId, ahora()); }
  handleLLMStart(_llm, _prompts, runId) { this.inicio.set(runId, ahora()); }
  handleLLMEnd(output, runId) {
    const ms = ahora() - (this.inicio.get(runId) ?? ahora());
    const msg = output?.generations?.[0]?.[0]?.message;
    const u = msg?.usage_metadata ?? {};
    const lo = output?.llmOutput?.tokenUsage ?? {};
    this.t.llm.llamadas += 1;
    this.t.llm.ms += ms;
    this.t.llm.tokens_in += u.input_tokens ?? lo.promptTokens ?? 0;
    this.t.llm.tokens_out += u.output_tokens ?? lo.completionTokens ?? 0;
  }
  handleLLMError(err, runId) {
    this.t.llm.llamadas += 1;
    this.t.llm.ms += ahora() - (this.inicio.get(runId) ?? ahora());
    this.t.errores.push(`llm: ${err?.message ?? err}`);
  }
  handleToolStart(tool, _input, runId, _p, _tags, _meta, name) {
    this.inicio.set(runId, { t: ahora(), nombre: name ?? tool?.name ?? "herramienta" });
  }
  handleToolEnd(output, runId) {
    const i = this.inicio.get(runId) ?? { t: ahora(), nombre: "herramienta" };
    const texto = typeof output === "string" ? output : output?.content ?? JSON.stringify(output ?? "");
    this.t.herramientas.push({ nombre: i.nombre, ms: redondear(ahora() - i.t), ok: true });
    if (i.nombre === "buscar_calendario_duoc") {
      try {
        const r = JSON.parse(texto);
        const sims = (r.resultados ?? []).map((x) => x.similitud).filter((x) => x != null);
        this.t.recuperacion = {
          modo: r.recuperacion ?? "?",
          n_resultados: r.resultados?.length ?? 0,
          mejor_similitud: sims.length ? Math.max(...sims) : null
        };
      } catch { /* salida no JSON */ }
    }
  }
  handleToolError(err, runId) {
    const i = this.inicio.get(runId) ?? { t: ahora(), nombre: "herramienta" };
    this.t.herramientas.push({ nombre: i.nombre, ms: redondear(ahora() - i.t), ok: false });
    this.t.errores.push(`tool ${i.nombre}: ${err?.message ?? err}`);
  }
}

export class Registrador {
  constructor({ archivo = process.env.LOG_PATH || "logs/ejecuciones.jsonl", modelo = process.env.OPENROUTER_MODEL || "openai/gpt-5.4", guardarTexto = process.env.LOG_TEXTO !== "off" } = {}) {
    this.archivo = archivo;
    this.modelo = modelo;
    this.guardarTexto = guardarTexto;
    this.ultimo = null;
  }

  /** Abre un turno. Devuelve { callback, nodo(), fin(), error() }. */
  iniciarTurno({ usuarioId, texto, meta = {} }) {
    const t0 = ahora();
    let marca = t0;
    const turno = {
      evento: "turno",
      turno_id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      usuario: seudonimo(usuarioId),
      modelo: this.modelo,
      meta,
      pregunta: this.guardarTexto ? anonimizarTexto(texto) : "[omitido]",
      intencion: null, modalidad: null, nodos: [],
      llm: { llamadas: 0, ms: 0, tokens_in: 0, tokens_out: 0 },
      herramientas: [], recuperacion: null,
      replans: 0, bloqueos_verificador: 0, mensaje_seguro: false, aclaracion: false,
      errores: []
    };
    const cb = new Medidor(turno);
    const reg = this;
    return {
      callback: cb,
      turno,
      /** Se llama cuando termina un nodo (stream "updates"): el tiempo entre eventos es la duración del nodo. */
      nodo(nombre, update = {}) {
        const n = ahora();
        turno.nodos.push({ nodo: nombre, ms: redondear(n - marca) });
        marca = n;
        if (nombre === "planificador" && update.plan) { turno.intencion = update.plan.intencion; turno.modalidad = update.plan.modalidad ?? null; }
        if (nombre === "replanificador") turno.replans += 1;
        if (nombre === "aclaracion") turno.aclaracion = true;
        if (nombre === "verificador" && update.feedback) turno.bloqueos_verificador += 1;
      },
      fin(respuesta) {
        turno.latencia_ms = redondear(ahora() - t0);
        turno.llm.ms = redondear(turno.llm.ms);
        turno.mensaje_seguro = respuesta === MENSAJE_SEGURO;
        turno.respuesta = reg.guardarTexto ? anonimizarTexto(respuesta) : "[omitido]";
        return reg.#escribir(turno);
      },
      error(e) {
        turno.latencia_ms = redondear(ahora() - t0);
        turno.llm.ms = redondear(turno.llm.ms);
        turno.errores.push(`turno: ${e?.message ?? e}`);
        turno.respuesta = null;
        return reg.#escribir(turno);
      }
    };
  }

  /** Línea adicional (p. ej. la calificación de una evaluación) asociada a un turno. */
  anotar(turno_id, datos) {
    this.#linea({ evento: "calificacion", turno_id, ...datos });
  }

  #escribir(turno) {
    this.ultimo = turno;
    this.#linea(turno);
    return turno;
  }
  #linea(obj) {
    try {
      fs.mkdirSync(path.dirname(this.archivo), { recursive: true });
      fs.appendFileSync(this.archivo, JSON.stringify(obj) + "\n", "utf8");
    } catch (e) {
      console.warn(`[observabilidad] no se pudo escribir el log: ${e.message}`);
    }
  }
}