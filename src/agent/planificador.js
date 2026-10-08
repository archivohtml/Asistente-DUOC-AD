// Lógica pura del planificador: heurística de respaldo + parseo/normalización del plan del LLM.
import { detectMode, necesitaModalidad, normalize } from "../calendario.js";

export const INTENCIONES = ["calendario", "agenda", "derivacion", "conversacion", "fuera_ambito"];

const RE_DERIVACION =
  /(apelar|apelacion|reclamo|beca|gratuidad|convalid|homolog|licencia|salud|enferm|expediente|certificado|titulacion|reintegro especial)/;
const RE_AGENDA = /(agenda|recordatorio|calendario personal|\bics\b|archivo|exporta|descarga|resumen de fechas|plan personal)/;
const RE_CALENDARIO =
  /(cuando|fecha|matricula|semana (cero|0)|semestre cero|induccion|inscrip|retiro|suspension|examen|clases|feriado|cierre|plazo|proximo|caducidad|encuesta|diagnostico|bimestre|semestre)/;
// Trámites cotidianos sobre ramos/matrícula en lenguaje coloquial ("soltar un curso", "pagar la matrícula"):
// son consultas de calendario aunque no contengan "fecha" ni "retiro". "convalidar un ramo" NO entra aquí.
const RE_TRAMITE =
  /((dejar|soltar|eliminar|borrar|bajar|anular|cancelar|quitar|botar)( me)? (de )?(un|una|el|la|mi|mis|los|las|ese|esa|este|esta)? ?(ramo|ramos|materia|materias|curso|cursos|asignatura|asignaturas)|(inscribir|inscribirme|tomar|agregar|cambiar)( me)? (un |una |el |la |mis |los |las )?(ramo|ramos|materia|materias|curso|cursos|asignatura|asignaturas)|pagar (la |mi )?matricula|bienvenida|(alumnos|estudiantes) nuevos|pruebas finales)/;

/** ¿El mensaje es, sin ambigüedad, un trámite de calendario (y no un caso individual)? */
export function esTramiteCalendario(mensaje) {
  const n = normalize(mensaje);
  return RE_TRAMITE.test(n) && !RE_DERIVACION.test(n);
}

const RE_CHARLA = /^(hola|buenas|gracias|listo|eso era todo|chao|eres|quien eres|que puedes|ayuda)/;

/** Clasificación determinista; se usa si el LLM planificador falla o como validación. */
export function planHeuristico({ mensaje, modalidadPerfil = "", intencionPrevia = null }) {
  const n = normalize(mensaje);
  let intencion = "fuera_ambito";
  if (RE_CHARLA.test(n)) intencion = "conversacion";
  else if (RE_AGENDA.test(n)) intencion = "agenda";
  else if (RE_DERIVACION.test(n) && !RE_CALENDARIO.test(n)) intencion = "derivacion";
  else if (RE_CALENDARIO.test(n) || RE_TRAMITE.test(n)) intencion = "calendario";
  else if (RE_DERIVACION.test(n)) intencion = "derivacion";

  // Seguimientos cortos ("¿y las online?", "¿hasta cuándo?") heredan la intención del turno previo.
  if (intencion === "fuera_ambito" && ["calendario", "agenda"].includes(intencionPrevia) && n.split(" ").length <= 6) {
    intencion = intencionPrevia;
  }

  const modalidad = detectMode(mensaje) || modalidadPerfil || "";
  const pasos = {
    calendario: ["buscar_calendario_duoc", "interpretar_estado_del_plazo", "responder_con_fuente"],
    agenda: ["buscar_calendario_duoc", "generar_agenda_personal", "confirmar_archivo"],
    derivacion: ["explicar_alcance", "derivar_a_funcionario"],
    conversacion: ["responder_directo"],
    fuera_ambito: ["indicar_fuera_de_alcance"]
  }[intencion];

  return { intencion, modalidad, actividad: null, pasos, origen: "heuristica" };
}

/** Extrae el primer objeto JSON de un texto (tolera ```json ... ```). */
export function extraerJSON(texto) {
  const m = /\{[\s\S]*\}/.exec(String(texto ?? ""));
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** Mezcla la salida del LLM con la heurística, validando campos. La modalidad conocida manda. */
export function normalizarPlan(crudo, { mensaje, modalidadPerfil = "", intencionPrevia = null }) {
  const base = planHeuristico({ mensaje, modalidadPerfil, intencionPrevia });
  if (!crudo || typeof crudo !== "object") return base;
  let intencion = INTENCIONES.includes(crudo.intencion) ? crudo.intencion : base.intencion;
  let pasos =
    Array.isArray(crudo.pasos) && crudo.pasos.length
      ? crudo.pasos.filter((p) => typeof p === "string").slice(0, 6)
      : base.pasos;
  // Validación: un trámite coloquial inequívoco ("quiero soltar un curso") no puede desviarse a derivación,
  // conversación o fuera de ámbito, porque eso evita que se ejecute la recuperación.
  if (["derivacion", "conversacion", "fuera_ambito"].includes(intencion) && esTramiteCalendario(mensaje)) {
    intencion = "calendario";
    pasos = base.pasos;
  }
  return {
    intencion,
    modalidad: detectMode(mensaje) || modalidadPerfil || detectMode(crudo.modalidad ?? "") || "",
    actividad: typeof crudo.actividad === "string" ? crudo.actividad : null,
    pasos,
    origen: "llm"
  };
}

/** ¿El plan exige preguntar modalidad antes de ejecutar? */
export function requiereAclaracion(plan, mensaje) {
  return (
    ["calendario", "agenda"].includes(plan.intencion) &&
    !plan.modalidad &&
    necesitaModalidad(mensaje, plan.modalidad)
  );
}

export const PREGUNTA_MODALIDAD =
  "Para darte la fecha correcta necesito saber tu modalidad: ¿eres de **base/presencial** (semestral) o **online** (bimestral)?";
