// Calibra el umbral de similitud con TU modelo de embeddings real (requiere OPENROUTER_API_KEY).
// Uso: npm run calibrar
// Para cada consulta de ejemplo imprime la mejor similitud y si recuperó la actividad esperada.
// Las consultas "negativas" (fuera de ámbito) deben quedar por DEBAJO del umbral; las positivas, por encima.
import "dotenv/config";
import { allRecords, normalize } from "../src/calendario.js";
import { OpenRouterEmbeddings } from "../src/retrieval/embeddings.js";
import { IndiceSemantico, claveRegistro, } from "../src/retrieval/indice.js";
import { MODELO_EMBEDDINGS_DEFECTO } from "../src/retrieval/embeddings.js";

const POSITIVAS = [
  ["¿hasta cuándo puedo dejar un ramo?", /retiro de asignaturas/],
  ["quiero soltar una materia", /retiro de asignaturas/],
  ["cuándo tengo que pagar la matrícula", /matr[ií]cula/],
  ["¿cuándo parten las pruebas finales?", /examen/],
  ["¿qué días no hay clases por feriado?", /feriado/],
  ["cuándo me puedo inscribir en los ramos", /inscripci[oó]n/],
  ["¿cuándo es la bienvenida de los alumnos nuevos?", /inducci[oó]n|semana cero/]
];
const NEGATIVAS = ["¿cómo está el clima hoy?", "receta de lasaña", "zzzz qqqq", "quién ganó el mundial", "arréglame este código en python"];

if (!process.env.OPENROUTER_API_KEY) {
  console.error("Falta OPENROUTER_API_KEY (copia .env.example a .env).");
  process.exit(1);
}
const modelo = process.env.EMBEDDING_MODEL || MODELO_EMBEDDINGS_DEFECTO;
const embeddings = new OpenRouterEmbeddings({ model: modelo });
const indice = new IndiceSemantico({ registros: allRecords, embeddings, modelo, cachePath: null });
await indice.construir();

async function top(q) {
  const sims = indice.similitudes(await embeddings.embedQuery(q));
  return allRecords.map((r) => ({ r, sim: sims.get(claveRegistro(r)) })).sort((a, b) => b.sim - a.sim);
}

const minOk = [];
const maxNeg = [];
console.log(`Modelo: ${modelo} | registros: ${indice.tamano}\n\nPOSITIVAS (¿la actividad esperada está en el top 3?)`);
for (const [q, esperado] of POSITIVAS) {
  const t = await top(q);
  const rango = t.findIndex((x) => esperado.test(normalize(x.r.actividad)) || esperado.test(x.r.actividad));
  const simEsperada = rango >= 0 ? t[rango].sim : 0;
  minOk.push(simEsperada);
  console.log(`${rango >= 0 && rango < 3 ? "✔" : "✘"} ${q}\n    mejor: ${t[0].sim.toFixed(3)} (${t[0].r.actividad}) · esperada en puesto ${rango + 1} con ${simEsperada.toFixed(3)}`);
}
console.log("\nNEGATIVAS (no deberían superar el umbral)");
for (const q of NEGATIVAS) {
  const t = await top(q);
  maxNeg.push(t[0].sim);
  console.log(`  ${q}\n    mejor: ${t[0].sim.toFixed(3)} (${t[0].r.actividad})`);
}
const piso = Math.min(...minOk);
const techo = Math.max(...maxNeg);
console.log(`\nPositiva más baja: ${piso.toFixed(3)} · negativa más alta: ${techo.toFixed(3)}`);
console.log(
  techo < piso
    ? `Umbral sugerido (SEMANTIC_MIN_SCORE): ${((piso + techo) / 2).toFixed(2)}`
    : "Las distribuciones se solapan: sube/baja el modelo (EMBEDDING_MODEL) o revisa los textos indexados antes de fijar un umbral."
);
