// Ventana de contexto por TURNOS (no por cantidad de mensajes), para no separar
// un AIMessage con tool_calls de sus ToolMessage (lo que rompería la API del LLM).
export function esHumano(m) {
  return (m?._getType?.() ?? m?.type) === "human";
}

export function ventanaPorTurnos(messages, maxTurnos = 8) {
  const idxHumanos = [];
  messages.forEach((m, i) => esHumano(m) && idxHumanos.push(i));
  if (idxHumanos.length <= maxTurnos) return messages;
  return messages.slice(idxHumanos[idxHumanos.length - maxTurnos]);
}

/** Mensajes del turno actual: desde el último mensaje humano en adelante. */
export function mensajesDelTurno(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (esHumano(messages[i])) return messages.slice(i);
  return messages;
}

export function textoDe(m) {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => p?.text ?? "").join(" ");
  return "";
}
