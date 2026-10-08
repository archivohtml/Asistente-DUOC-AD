// Pruebas del núcleo determinista (no requieren API key ni LangChain).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estadoActividad, extraerFechas, hoyActual, parseFecha, formatFecha } from "../src/lib/fechas.js";
import { buscarCalendario, necesitaModalidad, proximosHitos, detectMode } from "../src/calendario.js";
import { PerfilStore } from "../src/memory/perfilStore.js";
import { verificarFechas } from "../src/agent/verificador.js";
import { planHeuristico, extraerJSON, normalizarPlan, requiereAclaracion, esTramiteCalendario } from "../src/agent/planificador.js";
import { resumenRecuperacion } from "../src/lib/traza.js";
import { ventanaPorTurnos, mensajesDelTurno } from "../src/agent/ventana.js";

const HOY = new Date(Date.UTC(2026, 9, 7)); // 07-10-2026

test("fechas: parseo, formato y rechazo de fechas inválidas", () => {
  assert.equal(formatFecha(parseFecha("09-03-2026")), "09-03-2026");
  assert.equal(parseFecha("31-02-2026"), null);
  assert.equal(parseFecha("2026-03-09"), null);
});

test("fechas: FECHA_SIMULADA fija el 'hoy'", () => {
  assert.equal(formatFecha(hoyActual({ FECHA_SIMULADA: "2026-10-07" })), "07-10-2026");
});

test("fechas: estado respecto de hoy (finalizada / en_curso / por_comenzar)", () => {
  assert.equal(estadoActividad({ inicio: "10-08-2026", termino: "12-09-2026" }, HOY).estado, "finalizada");
  assert.equal(estadoActividad({ inicio: "10-08-2026", termino: "22-12-2026" }, HOY).estado, "en_curso");
  const f = estadoActividad({ inicio: "20-10-2026", termino: "20-12-2026" }, HOY);
  assert.equal(f.estado, "por_comenzar");
  assert.equal(f.dias_para_inicio, 13);
});

test("fechas: extrae formatos numéricos y en lenguaje natural", () => {
  const f = extraerFechas("Del 09-03-2026 al 11 de abril de 2026, y el 5 de mayo.");
  assert.equal(f.length, 3);
  assert.equal(f[2].anio, null);
});

test("calendario: retiro de asignaturas base trae estado calculado", () => {
  const r = buscarCalendario({ query: "cuándo es el retiro de asignaturas", modalidad: "base", hoy: HOY });
  assert.ok(r.resultados.length > 0);
  assert.equal(r.resultados[0].modalidad, "base/presencial");
  assert.ok(["finalizada", "en_curso", "por_comenzar"].includes(r.resultados[0].estado));
});

test("calendario: tolera errores de escritura de modalidad", () => {
  assert.equal(detectMode("las clases precenciales"), "base/presencial");
  assert.equal(detectMode("en línea"), "online");
});

test("calendario: semana cero sin modalidad exige aclaración", () => {
  const r = buscarCalendario({ query: "¿cuándo es la semana cero?", hoy: HOY });
  assert.equal(r.requiere_aclaracion, true);
});

test("calendario: consulta inexistente devuelve lista vacía (no inventa)", () => {
  assert.equal(buscarCalendario({ query: "zzzz qqqq", hoy: HOY }).resultados.length, 0);
});

test("necesitaModalidad: pregunta solo si las fechas difieren entre modalidades", () => {
  assert.equal(necesitaModalidad("retiro de asignaturas"), true);
  assert.equal(necesitaModalidad("feriado navidad"), false); // misma fecha en ambas
  assert.equal(necesitaModalidad("retiro de asignaturas", "online"), false);
});

test("proximosHitos: solo actividades en la ventana", () => {
  const r = proximosHitos({ modalidad: "online", dias: 14, hoy: HOY });
  assert.ok(r.resultados.length > 0);
  assert.ok(r.resultados.every((x) => x.estado !== "finalizada"));
});

test("memoria largo plazo: persiste, filtra campos y limita temas", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duoc-"));
  const store = new PerfilStore(path.join(dir, "p.json"));
  store.guardar("u1", { modalidad: "online", carrera: "Informática", hackeo: "x" });
  const otra = new PerfilStore(path.join(dir, "p.json")); // simula reinicio del proceso
  const p = otra.obtener("u1");
  assert.equal(p.modalidad, "online");
  assert.equal(p.hackeo, undefined);
  for (let i = 0; i < 8; i++) store.registrarTema("u1", `tema ${i}`);
  assert.equal(store.obtener("u1").ultimos_temas.length, 5);
  store.olvidar("u1");
  assert.deepEqual(store.obtener("u1"), {});
});

test("verificador: acepta fechas respaldadas por herramientas", () => {
  const tool = JSON.stringify({ resultados: [{ inicio: "09-03-2026", termino: "11-04-2026" }] });
  const v = verificarFechas({ respuesta: "El retiro va del 09-03-2026 al 11 de abril de 2026.", textosPermitidos: [tool], hoy: HOY });
  assert.equal(v.ok, true);
});

test("verificador: detecta fecha inventada", () => {
  const tool = JSON.stringify({ resultados: [{ inicio: "09-03-2026", termino: "11-04-2026" }] });
  const v = verificarFechas({ respuesta: "El retiro termina el 15-04-2026.", textosPermitidos: [tool], hoy: HOY });
  assert.equal(v.ok, false);
  assert.deepEqual(v.fechas_no_respaldadas, ["15-04-2026"]);
});

test("verificador: sin fechas o con 'hoy' no bloquea", () => {
  assert.equal(verificarFechas({ respuesta: "Hola, ¿en qué te ayudo?", hoy: HOY }).ok, true);
  assert.equal(verificarFechas({ respuesta: "Hoy es 07-10-2026.", hoy: HOY }).ok, true);
});

test("planificador: clasifica intenciones y deriva casos individuales", () => {
  assert.equal(planHeuristico({ mensaje: "¿cuándo es el retiro de asignaturas?" }).intencion, "calendario");
  assert.equal(planHeuristico({ mensaje: "quiero apelar mi beca" }).intencion, "derivacion");
  assert.equal(planHeuristico({ mensaje: "genérame un archivo .ics con mis fechas" }).intencion, "agenda");
  assert.equal(planHeuristico({ mensaje: "hola" }).intencion, "conversacion");
  assert.equal(planHeuristico({ mensaje: "¿quién ganó el mundial?" }).intencion, "fuera_ambito");
});

test("planificador: seguimiento corto hereda la intención previa", () => {
  assert.equal(planHeuristico({ mensaje: "¿y las online?", intencionPrevia: "calendario" }).intencion, "calendario");
});

test("planificador: parsea JSON del LLM, tolera basura y la modalidad del perfil manda", () => {
  assert.deepEqual(extraerJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(extraerJSON("no json"), null);
  const p = normalizarPlan({ intencion: "inventada", pasos: ["x"] }, { mensaje: "retiro de asignaturas", modalidadPerfil: "online" });
  assert.equal(p.intencion, "calendario"); // intención inválida → heurística
  assert.equal(p.modalidad, "online");
});

test("planificador: pide aclaración solo si falta modalidad y las fechas difieren", () => {
  const sin = planHeuristico({ mensaje: "retiro de asignaturas" });
  assert.equal(requiereAclaracion(sin, "retiro de asignaturas"), true);
  const con = planHeuristico({ mensaje: "retiro de asignaturas", modalidadPerfil: "online" });
  assert.equal(requiereAclaracion(con, "retiro de asignaturas"), false);
});

test("ventana: recorta por turnos sin separar tool_calls de sus resultados", () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ type: "human" }, { type: "ai", tool_calls: [{}] }, { type: "tool" }, { type: "ai" });
  const w = ventanaPorTurnos(msgs, 3);
  assert.equal(w[0].type, "human");
  assert.equal(w.filter((m) => m.type === "human").length, 3);
  assert.equal(mensajesDelTurno(msgs).length, 4);
});

test("planificador: trámites coloquiales son calendario (soltar un curso, dejar una materia, pagar la matrícula)", () => {
  for (const m of ["quiero soltar un curso", "¿hasta cuándo puedo dejar una materia?", "cuándo tengo que pagar la matrícula", "¿cuándo es la bienvenida de los alumnos nuevos?", "quiero eliminar un ramo"]) {
    assert.equal(planHeuristico({ mensaje: m }).intencion, "calendario", m);
    assert.equal(esTramiteCalendario(m), true, m);
  }
});

test("planificador: casos individuales siguen siendo derivación (convalidar, apelar, beca)", () => {
  for (const m of ["quiero convalidar un ramo", "quiero apelar para dejar un ramo", "me dieron una beca y tengo un reclamo"]) {
    assert.equal(planHeuristico({ mensaje: m }).intencion, "derivacion", m);
    assert.equal(esTramiteCalendario(m), false, m);
  }
});

test("planificador: si el LLM desvía un trámite coloquial a derivación, se corrige a calendario", () => {
  const llm = { intencion: "derivacion", modalidad: null, actividad: null, pasos: ["explicar_alcance", "derivar_a_funcionario"] };
  const p = normalizarPlan(llm, { mensaje: "quiero soltar un curso", modalidadPerfil: "base/presencial" });
  assert.equal(p.intencion, "calendario");
  assert.ok(p.pasos.includes("buscar_calendario_duoc"));
  // un caso individual real NO se corrige
  assert.equal(normalizarPlan(llm, { mensaje: "quiero apelar mi beca" }).intencion, "derivacion");
});

test("traza: resume modo y similitudes de la recuperación", () => {
  const msg = { name: "buscar_calendario_duoc", content: JSON.stringify({ recuperacion: "hibrida", resultados: [{ actividad: "retiro de asignaturas 2026-1", similitud: 0.403 }, { actividad: "x", similitud: 0.3 }] }) };
  assert.equal(resumenRecuperacion({ messages: [msg] }), "hibrida | 2 resultado(s) | 0.403 retiro de asignaturas 2026-1 | 0.300 x");
  assert.equal(resumenRecuperacion({ messages: [{ name: "otra", content: "{}" }] }), null);
  assert.equal(resumenRecuperacion({}), null);
});
