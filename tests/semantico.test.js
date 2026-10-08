// Pruebas de la recuperación semántica con un embedder FALSO y determinista (sin red ni API key).
// Validan la mecánica (índice, caché, similitud, fusión, filtros, fallback), no la calidad de un modelo real:
// para eso usa `npm run calibrar` con tu API key.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Embeddings } from "@langchain/core/embeddings";
import { buscarCalendario, normalize } from "../src/calendario.js";
import { crearRecuperador } from "../src/retrieval/recuperador.js";
import { cosenoSimilitud } from "../src/retrieval/indice.js";
import { OpenRouterEmbeddings } from "../src/retrieval/embeddings.js";

const HOY = new Date(Date.UTC(2026, 9, 7));

// Cada fila es un "concepto"; palabras distintas del mismo concepto comparten dimensión.
const CONCEPTOS = [
  ["retiro", "dejar", "soltar", "eliminar", "ramo", "ramos", "materia", "curso", "cursos", "asignaturas", "asignatura"],
  ["matricula", "inscribirme", "inscribir", "pagar", "arancel"],
  ["examen", "examenes", "prueba", "final"],
  ["feriado", "feriados", "festivo", "libre"]
];

class EmbedderFalso extends Embeddings {
  constructor() {
    super({});
    this.llamadasDocs = 0;
    this.llamadasQuery = 0;
  }
  #vec(texto) {
    // 4 dimensiones de concepto (peso 1) + 256 de "ruido léxico" (peso 0.35) para las demás palabras.
    // Sin el ruido, un texto sin conceptos quedaría igual a cualquier consulta sin conceptos.
    const v = new Array(CONCEPTOS.length + 256).fill(0);
    for (const t of normalize(texto).split(" ").filter(Boolean)) {
      const i = CONCEPTOS.findIndex((c) => c.includes(t));
      if (i >= 0) v[i] += 1;
      else v[CONCEPTOS.length + ([...t].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) % 256)] += 0.35;
    }
    return v;
  }
  async embedDocuments(ts) { this.llamadasDocs++; return ts.map((t) => this.#vec(t)); }
  async embedQuery(t) { this.llamadasQuery++; return this.#vec(t); }
}

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "duoc-s-")), "indice.json");
const recup = (extra = {}) => crearRecuperador({ embeddings: new EmbedderFalso(), modelo: "falso", cachePath: tmp(), log: () => {}, ...extra });

test("coseno: vectores iguales = 1, ortogonales = 0, nulo = 0", () => {
  assert.equal(cosenoSimilitud([1, 2], [1, 2]).toFixed(6), "1.000000");
  assert.equal(cosenoSimilitud([1, 0], [0, 1]), 0);
  assert.equal(cosenoSimilitud([0, 0], [1, 1]), 0);
});

test("semántico: un sinónimo que las palabras clave NO resuelven sí encuentra el retiro", async () => {
  const q = "dejar una materia";
  assert.equal(buscarCalendario({ query: q, modalidad: "base", hoy: HOY }).resultados.length, 0);
  const r = await recup().buscar({ query: q, modalidad: "base", hoy: HOY });
  assert.equal(r.recuperacion, "hibrida");
  assert.ok(r.resultados.length > 0);
  assert.ok(r.resultados.every((x) => /retiro/.test(x.actividad)), "solo debe traer retiros");
  assert.ok(r.resultados.every((x) => x.modalidad === "base/presencial"), "respeta el filtro de modalidad");
  assert.ok(r.resultados[0].similitud > 0.5);
});

test("semántico: conserva estado/días calculados por código (no por el LLM)", async () => {
  const r = await recup().buscar({ query: "soltar un curso", modalidad: "base", hoy: HOY });
  const retiro2 = r.resultados.find((x) => x.actividad.includes("2026-2"));
  assert.equal(retiro2.estado, "finalizada"); // 10-08 a ... ya pasó a 07-10-2026 o está calculado
  assert.ok("dias_para_termino" in retiro2);
});

test("semántico: sin modalidad trae ambas y pide aclaración", async () => {
  const r = await recup().buscar({ query: "dejar una materia", hoy: HOY });
  assert.equal(r.requiere_aclaracion, true);
});

test("semántico: consulta sin relación con el calendario no inventa resultados", async () => {
  const r = await recup().buscar({ query: "zzzz qqqq", modalidad: "base", hoy: HOY });
  assert.equal(r.resultados.length, 0);
});

test("híbrido: una coincidencia exacta de palabras clave se conserva aunque la similitud sea baja", async () => {
  const r = await recup().buscar({ query: "semestre de verano TAV", modalidad: "base", hoy: HOY });
  assert.ok(r.resultados.some((x) => /TAV/.test(x.actividad)));
});

test("semana cero se resuelve de forma determinista (sin llamar a embeddings)", async () => {
  const emb = new EmbedderFalso();
  const r = await crearRecuperador({ embeddings: emb, modelo: "falso", cachePath: tmp() }).buscar({ query: "¿cuándo es la semana cero?", hoy: HOY });
  assert.equal(r.requiere_aclaracion, true);
  assert.equal(emb.llamadasQuery, 0);
});

test("caché en disco: la segunda construcción no vuelve a embeber los registros", async () => {
  const cachePath = tmp();
  const e1 = new EmbedderFalso();
  await crearRecuperador({ embeddings: e1, modelo: "falso", cachePath }).precalentar();
  assert.equal(e1.llamadasDocs, 1);
  const e2 = new EmbedderFalso();
  const r = await crearRecuperador({ embeddings: e2, modelo: "falso", cachePath }).precalentar();
  assert.equal(r.embebidos, 0);
  assert.equal(e2.llamadasDocs, 0);
});

test("caché: cambiar de modelo invalida el índice", async () => {
  const cachePath = tmp();
  await crearRecuperador({ embeddings: new EmbedderFalso(), modelo: "A", cachePath }).precalentar();
  const e = new EmbedderFalso();
  const r = await crearRecuperador({ embeddings: e, modelo: "B", cachePath }).precalentar();
  assert.ok(r.embebidos > 0);
});

test("caché de consultas: repetir la misma pregunta no vuelve a llamar a la API", async () => {
  const emb = new EmbedderFalso();
  const rec = crearRecuperador({ embeddings: emb, modelo: "falso", cachePath: tmp() });
  await rec.buscar({ query: "dejar una materia", modalidad: "base", hoy: HOY });
  await rec.buscar({ query: "Dejar una materia", modalidad: "base", hoy: HOY });
  assert.equal(emb.llamadasQuery, 1);
});

test("fallback: si la API de embeddings falla, degrada a palabras clave sin lanzar error", async () => {
  const roto = new EmbedderFalso();
  roto.embedDocuments = async () => { throw new Error("HTTP 500"); };
  const avisos = [];
  const rec = crearRecuperador({ embeddings: roto, modelo: "falso", cachePath: tmp(), log: (m) => avisos.push(m) });
  const r = await rec.buscar({ query: "retiro de asignaturas", modalidad: "base", hoy: HOY });
  assert.equal(r.recuperacion, "palabras_clave");
  assert.ok(r.resultados.length > 0);
  assert.equal(avisos.length, 1);
  await rec.buscar({ query: "retiro de asignaturas", modalidad: "base", hoy: HOY }); // en cooldown: no reintenta ni re-avisa
  assert.equal(avisos.length, 1);
});

test("sin embeddings configurados: modo palabras clave", async () => {
  const rec = crearRecuperador({ embeddings: null });
  assert.equal(rec.modo, "palabras_clave");
  assert.equal((await rec.buscar({ query: "retiro de asignaturas", modalidad: "base", hoy: HOY })).recuperacion, "palabras_clave");
});

test("cliente OpenRouter: envía encoding_format float, ordena por index y valida la respuesta", async () => {
  let cuerpo;
  const fetchImpl = async (url, init) => {
    cuerpo = JSON.parse(init.body);
    assert.match(url, /\/embeddings$/);
    return { ok: true, json: async () => ({ data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }) };
  };
  const c = new OpenRouterEmbeddings({ apiKey: "k", fetchImpl });
  assert.deepEqual(await c.embedDocuments(["a", "b"]), [[1], [2]]);
  assert.equal(cuerpo.encoding_format, "float");

  const malo = new OpenRouterEmbeddings({ apiKey: "k", fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
  await assert.rejects(() => malo.embedQuery("x"), /inválida/);
  const http = new OpenRouterEmbeddings({ apiKey: "k", fetchImpl: async () => ({ ok: false, status: 401, text: async () => "no" }) });
  await assert.rejects(() => http.embedQuery("x"), /HTTP 401/);
});
