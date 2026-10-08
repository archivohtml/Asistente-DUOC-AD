import { ChatOpenAI } from "@langchain/openai";

/** Cliente LLM vía OpenRouter (API compatible con OpenAI). */
export function crearLLM({ model = process.env.OPENROUTER_MODEL || "openai/gpt-5.4", temperature = 0.2, maxTokens = 1200 } = {}) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("Falta OPENROUTER_API_KEY. Copia .env.example a .env y completa tu clave.");
  }
  return new ChatOpenAI({
    model,
    temperature,
    maxTokens,
    apiKey: process.env.OPENROUTER_API_KEY,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
        "X-Title": process.env.APP_NAME || "Asistente Academico Duoc"
      }
    }
  });
}
