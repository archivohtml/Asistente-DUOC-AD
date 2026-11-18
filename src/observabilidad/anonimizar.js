// Privacidad en los registros: se enmascaran datos personales ANTES de escribir en disco.
import crypto from "node:crypto";

const PATRONES = [
  [/\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/g, "[RUT]"],            // 12.345.678-9
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[CORREO]"],                // correo electrónico
  [/(?:\+?56\s?)?9[\s-]?\d{4}[\s-]?\d{4}\b/g, "[TELEFONO]"],     // celular chileno
  [/\b\d{9,}\b/g, "[NUMERO]"]                                    // otros números largos (cuentas, folios)
];

/** Reemplaza RUT, correos y teléfonos por etiquetas. */
export function anonimizarTexto(texto) {
  let t = String(texto ?? "");
  for (const [re, etiqueta] of PATRONES) t = t.replace(re, etiqueta);
  return t;
}

/** Identificador de usuario irreversible (hash con sal): permite agrupar sin identificar. */
export function seudonimo(usuarioId, sal = process.env.LOG_SALT || "duoc-ia") {
  return "u_" + crypto.createHash("sha256").update(`${sal}:${usuarioId}`).digest("hex").slice(0, 10);
}