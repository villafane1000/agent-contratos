# Agente Conversacional (Extraer Datos de Contratos) — Reto 2

Agente en TypeScript (Node 22) que recibe el buzón de contratos, clasifica cada correo, extrae los datos del contrato con confianza por campo, valida contra el maestro y el catálogo de comerciales, y escribe en un SharePoint simulado **solo con confirmación humana**. También archiva documentos y reporta vencimientos.

**URL pública:** https://agente-conversacional-extraer-datos-de-contratos.vercel.app · **Repo:** https://github.com/villafane1000/agent-contratos

## Mapa de entregables

| Entregable | Dónde |
|---|---|
| System prompt | `agent/prompt.md` |
| Herramientas zod | `src/tools/contratos.ts` |
| Backend / ciclo del agente | `src/agent/runtime.ts`, `api/chat.ts` |
| Reglas (sin LLM) | `src/domain/` |
| Frontend de chat (herramientas y confirmaciones visibles) | `public/index.html` |
| Script de verificación sin LLM | `demo.ts` |
| Documentación, costos y regla de gobierno | `SOLUCION.md` |

## Probar

```bash
npm ci
npx tsx demo.ts     # procesa msg-001..msg-006 sin LLM
npm test
npm run dev         # http://localhost:3000
```

En el chat: "¿Qué hay en el buzón?", "procesa msg-001" (aparece el recuadro Aprobar/Rechazar), "procesa todo y dame un resumen", "reporte de vencimientos". El selector **Con LLM / Sin LLM** cambia el modo de orquestación.

## Adaptar a los fixtures oficiales

1. Copiar `fixtures/reto-02/` sin renombrar archivos.
2. Ajustar el mapeo de columnas y campos en `src/data/repo.ts`.
3. Ajustar los patrones de `src/domain/extraccion.ts` y las reglas y el umbral de `src/domain/controles.ts` según el PRD.
4. `npx tsx demo.ts` hasta que los 6 casos den lo esperado; actualizar `tests/` y `SOLUCION.md` (buscar **[AJUSTAR]**).
