// Guardrail determinista anti-alucinación de fechas.
// Regla: toda fecha que aparezca en la respuesta final debe provenir de (a) una herramienta
// ejecutada en este turno, (b) el mensaje del estudiante, o (c) la fecha de "hoy".
import { extraerFechas, formatFecha, hoyActual } from "../lib/fechas.js";

const claveCompleta = ({ dia, mes, anio }) => `${anio}-${mes}-${dia}`;
const claveParcial = ({ dia, mes }) => `${mes}-${dia}`;

export function verificarFechas({ respuesta, textosPermitidos = [], hoy = hoyActual() }) {
  const permitidas = [...textosPermitidos, formatFecha(hoy)].flatMap(extraerFechas);
  const completas = new Set(permitidas.filter((f) => f.anio).map(claveCompleta));
  const parciales = new Set(permitidas.map(claveParcial));

  const invalidas = extraerFechas(respuesta).filter((f) =>
    f.anio ? !completas.has(claveCompleta(f)) : !parciales.has(claveParcial(f))
  );

  return {
    ok: invalidas.length === 0,
    fechas_no_respaldadas: invalidas.map((f) => f.texto)
  };
}

export const MENSAJE_SEGURO =
  "No pude validar las fechas de mi respuesta contra el calendario oficial, así que prefiero no entregártelas " +
  "para evitar que te equivoques. Te recomiendo confirmarlas con secretaría académica o la dirección de carrera de tu sede.";
