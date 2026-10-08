// Memoria de LARGO PLAZO: perfil del estudiante persistido en disco (JSON).
// Sobrevive entre ejecuciones; la memoria de corto plazo vive en el checkpointer de LangGraph.
import fs from "node:fs";
import path from "node:path";

const CAMPOS_PERMITIDOS = ["nombre", "modalidad", "carrera", "sede", "jornada"];
const MAX_TEMAS = 5;

export class PerfilStore {
  constructor(archivo = process.env.MEMORIA_PATH || "data/memoria/perfiles.json") {
    this.archivo = archivo;
  }

  #leerTodo() {
    try {
      return JSON.parse(fs.readFileSync(this.archivo, "utf8"));
    } catch {
      return {};
    }
  }

  #escribirTodo(data) {
    fs.mkdirSync(path.dirname(this.archivo), { recursive: true });
    fs.writeFileSync(this.archivo, JSON.stringify(data, null, 2), "utf8");
  }

  obtener(usuarioId) {
    return this.#leerTodo()[usuarioId] ?? {};
  }

  /** Actualiza solo campos permitidos y no vacíos. Devuelve el perfil resultante. */
  guardar(usuarioId, patch = {}) {
    const todo = this.#leerTodo();
    const actual = todo[usuarioId] ?? {};
    for (const campo of CAMPOS_PERMITIDOS) {
      const v = patch[campo];
      if (typeof v === "string" && v.trim()) actual[campo] = v.trim();
    }
    if (Array.isArray(patch.ultimos_temas)) {
      actual.ultimos_temas = patch.ultimos_temas.slice(-MAX_TEMAS);
    }
    actual.actualizado = new Date().toISOString();
    todo[usuarioId] = actual;
    this.#escribirTodo(todo);
    return actual;
  }

  /** Memoria episódica ligera: recuerda los últimos temas consultados. */
  registrarTema(usuarioId, tema) {
    if (!tema) return this.obtener(usuarioId);
    const temas = (this.obtener(usuarioId).ultimos_temas ?? []).filter((t) => t !== tema);
    temas.push(tema);
    return this.guardar(usuarioId, { ultimos_temas: temas });
  }

  olvidar(usuarioId) {
    const todo = this.#leerTodo();
    delete todo[usuarioId];
    this.#escribirTodo(todo);
  }
}
