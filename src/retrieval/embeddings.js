// Cliente de embeddings vía OpenRouter, compatible con la interfaz `Embeddings` de LangChain
// (embedDocuments / embedQuery), de modo que se puede reemplazar por cualquier otro proveedor.
import { Embeddings } from "@langchain/core/embeddings";

export const MODELO_EMBEDDINGS_DEFECTO = "openai/text-embedding-3-small";

export class OpenRouterEmbeddings extends Embeddings {
  constructor({
    apiKey = process.env.OPENROUTER_API_KEY,
    model = process.env.EMBEDDING_MODEL || MODELO_EMBEDDINGS_DEFECTO,
    baseURL = "https://openrouter.ai/api/v1",
    timeoutMs = 15_000,
    batchSize = 64,
    fetchImpl = globalThis.fetch
  } = {}) {
    super({});
    if (!apiKey) throw new Error("Falta OPENROUTER_API_KEY para generar embeddings.");
    Object.assign(this, { apiKey, model, baseURL, timeoutMs, batchSize, fetchImpl });
  }

  async embedDocuments(textos) {
    const salida = [];
    for (let i = 0; i < textos.length; i += this.batchSize) {
      salida.push(...(await this.#pedir(textos.slice(i, i + this.batchSize))));
    }
    return salida;
  }

  async embedQuery(texto) {
    return (await this.#pedir([texto]))[0];
  }

  async #pedir(input) {
    const res = await this.fetchImpl(`${this.baseURL}/embeddings`, {
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
        "X-Title": process.env.APP_NAME || "Asistente Academico Duoc"
      },
      body: JSON.stringify({ model: this.model, input, encoding_format: "float" })
    });
    if (!res.ok) {
      throw new Error(`Embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = await res.json();
    const datos = [...(json.data ?? [])].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (datos.length !== input.length || datos.some((v) => !Array.isArray(v))) {
      throw new Error("Respuesta de embeddings inválida (cantidad o formato inesperado).");
    }
    return datos;
  }
}
