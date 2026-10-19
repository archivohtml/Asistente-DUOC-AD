// Recuperación HÍBRIDA: similitud semántica (embeddings) + coincidencia por palabras clave,
// fusionadas con Reciprocal Rank Fusion. Si los embeddings no están disponibles, degrada a palabras clave.
import path from "node:path";
import {
  allRecords,
  buscarCalendario,
  detectMode,
  enriquecer,
  esSemanaCero,
  normalize,
  puntuar
} from "../calendario.js";
import { hoyActual } from "../lib/fechas.js";
import { OpenRouterEmbeddings, MODELO_EMBEDDINGS_DEFECTO } from "./embeddings.js";
import { IndiceSemantico, claveRegistro } from "./indice.js";

const K_RRF = 60;
const redondear = (n) => Math.round(n * 1000) / 1000;

export function crearRecuperador({
  embeddings = null,
  modelo = process.env.EMBEDDING_MODEL || MODELO_EMBEDDINGS_DEFECTO,
  cachePath = process.env.EMBEDDINGS_CACHE || path.join("data", "embeddings", "indice.json"),
    minSimilitud = Number(process.env.SEMANTIC_MIN_SCORE ?? 0.33),
  margen = Number(process.env.SEMANTIC_MARGIN ?? 0.12),
  maxResultados = 8,
  registros = allRecords,
  log = (m) => console.warn(m)
} = {}) {
  let indice = null;
  let construyendo = null;
  const cacheConsultas = new Map(); // consulta normalizada -> vector
  let avisado = false;
  let reintentarDesde = 0; // tras un fallo de red, no insistir durante 60 s

  async function precalentar() {
    if (!embeddings) return { modo: "palabras_clave", embebidos: 0 };
    if (indice) return { modo: "hibrida", embebidos: 0 };
    construyendo ??= (async () => {
      const nuevo = new IndiceSemantico({ registros, embeddings, modelo, cachePath });
      const embebidos = await nuevo.construir();
      indice = nuevo;
      return { modo: "hibrida", embebidos };
    })().finally(() => {
      construyendo = null;
    });
    return construyendo;
  }

  async function vectorDe(query) {
    const k = normalize(query);
    if (!cacheConsultas.has(k)) {
      if (cacheConsultas.size >= 200) cacheConsultas.delete(cacheConsultas.keys().next().value);
      cacheConsultas.set(k, await embeddings.embedQuery(query));
    }
    return cacheConsultas.get(k);
  }

  function degradar(args, motivo) {
    if (!avisado) {
      avisado = true;
      log(`[recuperación] Sin embeddings (${motivo}). Uso búsqueda por palabras clave.`);
    }
    return { ...buscarCalendario(args), recuperacion: "palabras_clave" };
  }

  async function buscar({ query = "", modalidad = "", hoy = hoyActual() } = {}) {
    const args = { query, modalidad, hoy };
    const nq = normalize(query);
    // "Semana cero" tiene reglas exactas (y aclaración de modalidad): se resuelve de forma determinista.
    if (!nq || esSemanaCero(nq) || !embeddings) {
      return { ...buscarCalendario(args), recuperacion: "palabras_clave" };
    }

    if (Date.now() < reintentarDesde) return { ...buscarCalendario(args), recuperacion: "palabras_clave" };
    let sims;
    try {
      await precalentar();
      sims = indice.similitudes(await vectorDe(query));
    } catch (e) {
      reintentarDesde = Date.now() + 60_000;
      return degradar(args, e.message);
    }

    const mode = detectMode(query, modalidad);
    const pool = mode ? registros.filter((r) => r.modalidad === mode) : registros;

    const kw = new Map(puntuar(nq, mode).map((x) => [claveRegistro(x.record), x.score]));
    const porSim = pool
      .map((r) => ({ r, sim: sims.get(claveRegistro(r)) ?? 0 }))
      .sort((a, b) => b.sim - a.sim);
    const mejor = porSim[0]?.sim ?? 0;
    const rangoSem = new Map(porSim.map((x, i) => [claveRegistro(x.r), i + 1]));
    const rangoKw = new Map(
      [...kw].sort((a, b) => b[1] - a[1]).map(([k], i) => [k, i + 1])
    );

    const elegidos = porSim
      .filter(({ r, sim }) => (sim >= minSimilitud && sim >= mejor - margen) || kw.has(claveRegistro(r)))
      .map(({ r, sim }) => {
        const k = claveRegistro(r);
        const rrf = 1 / (K_RRF + rangoSem.get(k)) + (rangoKw.has(k) ? 1 / (K_RRF + rangoKw.get(k)) : 0);
        return { r, sim, rrf };
      })
      .sort((a, b) => b.rrf - a.rrf)
      .slice(0, maxResultados);

    const resultados = elegidos.map(({ r, sim }) => ({ ...enriquecer(r, hoy), similitud: redondear(sim) }));
    return {
      query,
      hoy: hoy.toISOString().slice(0, 10),
      modalidad_consultada: mode || "no especificada",
      resultados,
      requiere_aclaracion:
        !mode &&
        resultados.some((x) => x.modalidad === "base/presencial") &&
        resultados.some((x) => x.modalidad === "online"),
      nota: null,
      recuperacion: "hibrida"
    };
  }

  return { buscar, precalentar, get modo() { return embeddings ? "hibrida" : "palabras_clave"; } };
}

/** Híbrido si hay API key y no está desactivado (SEMANTIC_SEARCH=off); si no, solo palabras clave. */
export function crearRecuperadorPorDefecto(opts = {}) {
  const activo = process.env.OPENROUTER_API_KEY && process.env.SEMANTIC_SEARCH !== "off";
  return crearRecuperador({ embeddings: activo ? new OpenRouterEmbeddings() : null, ...opts });
}
