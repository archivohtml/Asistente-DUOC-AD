// Índice vectorial en memoria sobre los registros del calendario, con caché en disco.
// Cada registro se indexa como texto enriquecido; el caché se invalida por huella (sha256) del texto + modelo,
// así que solo se re-embeben los registros que cambian.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function textoIndexable(r) {
  return `${r.actividad}. También conocido como: ${r.aliases}. Calendario ${r.modalidad}.`;
}

export const claveRegistro = (r) => `${r.modalidad}|${r.actividad}`;

export function cosenoSimilitud(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const huella = (modelo, texto) => crypto.createHash("sha256").update(`${modelo}\n${texto}`).digest("hex").slice(0, 24);

export class IndiceSemantico {
  #vectores = new Map(); // claveRegistro -> number[]

  constructor({ registros, embeddings, modelo, cachePath = null }) {
    Object.assign(this, { registros, embeddings, modelo, cachePath });
  }

  get tamano() {
    return this.#vectores.size;
  }

  #leerCache() {
    if (!this.cachePath || !fs.existsSync(this.cachePath)) return {};
    try {
      const j = JSON.parse(fs.readFileSync(this.cachePath, "utf8"));
      return j.modelo === this.modelo ? j.items ?? {} : {};
    } catch {
      return {}; // caché corrupto: se regenera
    }
  }

  #escribirCache(items) {
    if (!this.cachePath) return;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify({ modelo: this.modelo, items }), "utf8");
    } catch {
      /* el caché es opcional */
    }
  }

  /** Construye el índice; devuelve cuántos registros hubo que embeber (0 = todo vino del caché). */
  async construir() {
    const cache = this.#leerCache();
    const vigentes = {};
    const faltantes = [];
    for (const r of this.registros) {
      const h = huella(this.modelo, textoIndexable(r));
      if (cache[h]) vigentes[h] = cache[h];
      else faltantes.push({ r, h });
    }
    if (faltantes.length) {
      const vecs = await this.embeddings.embedDocuments(faltantes.map((f) => textoIndexable(f.r)));
      faltantes.forEach((f, i) => (vigentes[f.h] = vecs[i]));
      this.#escribirCache(vigentes);
    }
    this.#vectores.clear();
    for (const r of this.registros) {
      this.#vectores.set(claveRegistro(r), vigentes[huella(this.modelo, textoIndexable(r))]);
    }
    return faltantes.length;
  }

  /** Similitud coseno de un vector de consulta contra cada registro: Map(claveRegistro -> sim). */
  similitudes(vectorConsulta) {
    return new Map([...this.#vectores].map(([k, v]) => [k, cosenoSimilitud(vectorConsulta, v)]));
  }
}
