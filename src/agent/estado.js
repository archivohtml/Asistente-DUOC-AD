import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

const ultimo = (_a, b) => b;

/**
 * Estado compartido del grafo.
 *  - messages: memoria de CORTO plazo (historial; persistido por el checkpointer según thread_id)
 *  - perfil:   memoria de LARGO plazo cargada desde PerfilStore al inicio de cada turno
 *  - plan:     salida del planificador para el turno actual
 *  - replans / reintentos: contadores de adaptación (replanificación y corrección del verificador)
 */
export const EstadoAgente = Annotation.Root({
  ...MessagesAnnotation.spec,
  perfil: Annotation({ reducer: ultimo, default: () => ({}) }),
  plan: Annotation({ reducer: ultimo, default: () => null }),
  replans: Annotation({ reducer: ultimo, default: () => 0 }),
  reintentos: Annotation({ reducer: ultimo, default: () => 0 }),
  feedback: Annotation({ reducer: ultimo, default: () => "" })
});
