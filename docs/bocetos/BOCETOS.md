# Bocetos de diseño (parcial 3)

| Archivo | Qué muestra |
|---|---|
| [`flujo_observabilidad.png`](flujo_observabilidad.png) | Flujo de datos de la observabilidad: agente → registrador → anonimización → `logs/ejecuciones.jsonl` → métricas, `ultima_corrida.js` y dashboard. Fuente editable en [`flujo.mmd`](flujo.mmd) (Mermaid). |
| [`boceto_dashboard.png`](boceto_dashboard.png) | Wireframe del dashboard: filtros, KPIs, 5 gráficos y tabla de turnos fallidos con detalle al hacer clic. Implementado en `scripts/dashboard.js`. |
