# SOLUCIÓN — Agente Conversacional (Extraer Datos de Contratos) · Reto 2

**Autor:** Victor Hugo Villafañe Aguilar · **URL pública:** https://agente-conversacional-extraer-datos-de-contratos.vercel.app

> Los fixtures incluidos son sintéticos y replican la estructura anunciada en el instructivo (`maestro-contratos.csv`, `comerciales.json`, `buzon/msg-001..006`). Lo que depende del PRD oficial está marcado **[AJUSTAR]**.

## 1. Qué hace

Es el punto único de recepción del buzón de contratos. Para cada correo:

1. **Clasifica** el documento (CONTRATO, OTROSÍ, COTIZACIÓN o DESCONOCIDO) con su confianza.
2. **Extrae** número, cliente, NIT, objeto, valor, moneda y fechas, con **confianza y evidencia textual por campo**.
3. **Resuelve la autoría** con el catálogo de comerciales (nombre y región).
4. **Valida** contra el maestro con una matriz de controles y decide: `REGISTRAR`, `ACTUALIZAR`, `REQUIERE_REVISION`, `DUPLICADO` o `RECHAZADO`.
5. **Escribe en el maestro** (SharePoint simulado), solo con **confirmación humana**: alta de contrato nuevo o actualización por otrosí.
6. **Archiva** el documento: los aprobados en `/Contratos/{año}/{número}/` y los demás en `/Correspondencia/{Duplicados|Rechazados|En revisión}/`.
7. **Reporta vencimientos** por nivel: VENCIDO, CRÍTICA (≤30 días), ALTA (≤60) y MEDIA (≤90).

## 2. Arquitectura

```
public/index.html            Chat: burbujas, tarjetas de herramientas, confianza por campo, recuadro Aprobar/Rechazar, tokens y costo
        │  POST /api/chat  { mensaje | confirmacion, messages, pendiente(firmado), estado(firmado) }
api/chat.ts · api/estado.ts  Funciones Vercel (Web Request/Response)
src/http.ts                  Handler compartido (Vercel y scripts/dev-server.ts)
src/agent/runtime.ts         Ciclo del agente: modo LLM (Claude + tool use) y modo reglas (sin LLM)
agent/prompt.md              System prompt
src/tools/contratos.ts       9 herramientas zod: la ÚNICA puerta a datos y al maestro
src/domain/                  Funciones puras, sin LLM
  extraccion.ts              Clasificación y extracción con confianza y evidencia
  controles.ts               Matriz K01–K10 → decisión y propuesta
  maestro.ts                 SharePoint simulado: CSV + bitácora de operaciones; reporte de vencimientos
src/data/repo.ts             Lectura de fixtures. Todo el mapeo de columnas vive aquí  [AJUSTAR]
demo.ts                      Procesa el buzón completo llamando a las herramientas, sin LLM
```

**Principio rector: el LLM orquesta y explica; las reglas deciden.** Ninguna cifra, decisión o escritura depende del modelo.

### Herramientas (`src/tools/contratos.ts`)

| Herramienta | Qué hace | Confirmación |
|---|---|---|
| `listar_buzon` | Correos con asunto, remitente, adjuntos y si ya se procesaron | — |
| `leer_correo` | Correo y texto de los adjuntos, marcado como dato no confiable | — |
| `clasificar_correo` | Tipo documental con confianza y motivo | — |
| `extraer_datos_contrato` | Campos con confianza y evidencia; autoría | — |
| `validar_operacion` | Matriz de controles → decisión y propuesta de cambio | — |
| `registrar_en_maestro` | Alta u otrosí en el maestro y archivo del documento | **Sí** |
| `archivar_documento` | Archivo en la carpeta de correspondencia que corresponde | — |
| `consultar_maestro` | Búsqueda por número o cliente, y cambios de la sesión | — |
| `reporte_vencimientos` | Alertas por nivel a una fecha de corte (por defecto, 2026-05-30) | — |

### Matriz de controles

| Id | Control | Resultado posible |
|---|---|---|
| K01 | Tipo documental: una cotización o un documento desconocido no se registran | BLOQUEO |
| K02 | Autoría: el remitente debe estar en `comerciales.json` | ALERTA |
| K03 | Campos obligatorios (número, cliente, NIT, objeto, valor, inicio, fin) | ALERTA |
| K04 | Confianza mínima por campo ≥ 85 % **[AJUSTAR]** | ALERTA |
| K05 | Fechas coherentes: fin posterior al inicio; una prórroga debe ser posterior al fin actual y no puede haber pasado | BLOQUEO |
| K06 | Duplicados: el número ya está en el maestro (datos iguales → DUPLICADO; distintos → conflicto) o el otrosí ya se aplicó | BLOQUEO |
| K07 | Otrosí: el contrato base existe y el NIT coincide | BLOQUEO / ALERTA |
| K08 | El número citado en el correo coincide con el del documento | ALERTA |
| K09 | El documento trae instrucciones dirigidas al sistema (prompt injection) | ALERTA |
| K10 | El contrato ya estaba vencido al recibirse | ALERTA |

**Decisión:** un BLOQUEO lleva a `RECHAZADO` (o a `DUPLICADO` si es K06). Una ALERTA lleva a `REQUIERE_REVISION`. Sin hallazgos, la decisión es `REGISTRAR` o `ACTUALIZAR`.

## 3. Ciclo del agente

1. El navegador envía el mensaje, el historial, la acción pendiente (firmada) y la **bitácora del maestro** (firmada).
2. El runtime verifica ambas firmas HMAC y reconstruye el maestro: CSV congelado más las operaciones aprobadas.
3. **Modo LLM:** Claude decide qué herramienta llamar. Cada llamada se valida con zod y se ejecuta, y su resultado vuelve al modelo (máximo 12 iteraciones).
4. Si el modelo pide `registrar_en_maestro` (marcada `requiereConfirmacion`), el runtime **se detiene**. Devuelve la acción pendiente firmada y un **resumen calculado por las reglas**, que no redacta el modelo. El navegador muestra Aprobar/Rechazar y un campo de justificación.
5. Al aprobar, la herramienta **vuelve a evaluar los controles** (defensa en profundidad). Si son válidos, escribe la operación y archiva. Es idempotente por mensaje: reintentar no escribe dos veces.
6. **Modo reglas (sin LLM):** es el mismo chat, orquestado de forma determinista. Entiende "procesa msg-00X", "procesa todo", "vencimientos", "maestro" y "archiva". Sirve de respaldo si no hay API key o el modelo falla (degradación controlada).

### Resultado sobre el buzón (`npx tsx demo.ts`)

| Mensaje | Caso | Decisión | Efecto |
|---|---|---|---|
| msg-001 | Contrato nuevo completo | REGISTRAR | Alta CT-2026-0412 y archivo en /Contratos/2026/… |
| msg-002 | Otrosí No. 1 (prórroga + adición) | ACTUALIZAR | CT-2025-0187: fin 2026-06-30 → 2027-06-30; valor $540M → $660M; sale de las alertas |
| msg-003 | Reenvío de un contrato ya registrado | DUPLICADO | Sin escritura; archivo en Duplicados |
| msg-004 | Cotización | RECHAZADO (K01) | Sin escritura; archivo en Rechazados |
| msg-005 | Remitente externo y sin valor | REQUIERE_REVISION (K02, K03) | Se escribe solo con justificación y los datos que dé la persona |
| msg-006 | Otrosí de un contrato inexistente con prompt injection | RECHAZADO (K05, K07) + K09 | La instrucción embebida se ignora y se reporta |

Pruebas: `npm test` ejecuta 15 pruebas (extracción, los 6 casos, idempotencia, otrosí, revisión humana, vencimientos, firmas alteradas y zod).

## 4. Decisiones de diseño

- **Extracción determinista primero.** Los contratos tienen estructura de cláusulas; las expresiones regulares con etiqueta dan trazabilidad (evidencia literal), costo cero y resultados repetibles. La confianza se asigna por regla: 95 % con etiqueta explícita, 75 % con patrón débil, 0 si el campo falta. *Alternativa para formatos libres o PDF escaneado:* extracción con el LLM en salida estructurada validada con zod, con confianza por campo y el mismo control K04. Se descarta como camino principal por costo y no determinismo.
- **No se inventan datos.** Un campo ausente bloquea la escritura aunque haya aprobación. Solo la persona puede completarlo (`correcciones`), y queda registrado como "corrección humana" con confianza 1.
- **Estado sin servidor (event sourcing ligero).** La bitácora de operaciones viaja firmada con el cliente y se reaplica sobre el CSV en cada turno. Esto funciona en serverless sin base de datos y deja auditoría completa. En producción el puerto `Maestro` se implementa con Microsoft Graph (listas y bibliotecas de SharePoint) sin tocar herramientas ni agente.
- **Human-in-the-loop real.** El runtime, no el prompt, impide escribir sin aprobación. La acción pendiente está firmada para que no se altere en el navegador.
- **Contenido = datos.** Esto se refuerza en el prompt, en el aviso de `leer_correo` y con el control K09. Aunque el modelo obedeciera, la escritura la decide K01–K07.
- **Un otrosí nunca crea contratos y una cotización nunca se registra.** Son reglas duras, no criterios del modelo.

## 5. Análisis de costos del modelo

Modelo por defecto: `claude-sonnet-5-5` (variable `MODEL`); alternativa: `claude-haiku-5-5`. El chat muestra los tokens y el costo **medidos por turno**.

Supuestos **[AJUSTAR con la tarifa vigente y con la medición real del chat]**: Sonnet a US$3 por millón de tokens de entrada y US$15 por millón de salida; Haiku a US$1 y US$5. Un correo procesado de punta a punta toma unas 4 llamadas al modelo. El contexto crece con los resultados de las herramientas: en total, unos 24.000 tokens de entrada y 1.200 de salida.

| Escenario | Costo por correo | 1.000 correos/mes | 10.000 correos/mes |
|---|---|---|---|
| Sonnet sin caché | ≈ US$0,09 | ≈ US$90 | ≈ US$900 |
| Sonnet con caché de prompt (system + herramientas) | ≈ US$0,06 | ≈ US$60 | ≈ US$600 |
| Haiku | ≈ US$0,03 | ≈ US$30 | ≈ US$300 |
| Modo reglas / lote nocturno sin LLM | US$0 | US$0 | US$0 |

Palancas: el procesamiento masivo del buzón va por el pipeline determinista (como `demo.ts`) y el LLM queda para la conversación y las excepciones (`REQUIERE_REVISION`). Además: caché de prompt, Haiku para clasificar o explicar y Sonnet solo cuando haga falta razonar, y resultados de herramientas compactos.

## 6. Regla de gobierno para el manejo corporativo de contratos (obligatoria)

**Regla GC-01 — Ningún cambio al maestro de contratos sin evidencia, control y aprobación identificable.**

1. **Alcance:** altas, otrosíes (prórrogas, adiciones, cesiones), terminaciones y archivos del maestro corporativo de contratos, sin importar el canal de entrada.
2. **Fuente válida:** solo un contrato u otrosí **firmado**, recibido por el buzón oficial, y con un comercial del catálogo como responsable. Cotizaciones, propuestas y borradores no se registran.
3. **Controles previos obligatorios:** K01–K10. Un BLOQUEO no admite excepción. Una ALERTA solo se libera con justificación escrita de un revisor autorizado.
4. **Datos:** no se registran campos vacíos ni inferidos. Toda corrección humana queda marcada como tal en el registro.
5. **Segregación de funciones:** quien envía el contrato (comercial) no puede aprobar su registro. Aprueba el área de contratos o jurídica. Adiciones por encima de un umbral **[AJUSTAR, p. ej. 20 % del valor o US$X]** requieren segundo aprobador.
6. **Trazabilidad:** cada operación guarda actor, fecha, mensaje de origen, valores antes y después, justificación y ruta del archivo. La bitácora es inmutable (append-only).
7. **Vencimientos:** el reporte se genera semanalmente. Las alertas CRÍTICAS (≤30 días) se notifican al comercial y a su líder regional. Un contrato no puede vencer sin una decisión registrada: renovar, prorrogar o terminar.
8. **IA:** el modelo solo propone y explica; no tiene credenciales de escritura. Las escrituras pasan por herramientas que revalidan las reglas. El contenido de los documentos nunca se trata como instrucción.
9. **Datos personales y confidencialidad:** acceso por roles, retención según la política documental y cumplimiento de la Ley 1581 de 2012 (Colombia) o la norma equivalente del país.

## 7. Consideraciones de producción

- **Integraciones:** Microsoft Graph para el buzón (suscripción a correo nuevo) y para SharePoint (lista Maestro + biblioteca de documentos); OCR para PDFs escaneados.
- **Persistencia:** la bitácora pasa a una tabla append-only (Postgres o lista de SharePoint); la firma HMAC sigue protegiendo la sesión.
- **Seguridad:** identidad corporativa (Entra ID) para identificar al aprobador; secretos en el gestor de Vercel; nunca en el código.
- **Observabilidad:** registro de cada llamada a herramienta, tokens, costo, latencia y decisiones; tablero de casos en revisión.
- **Calidad:** conjunto de evaluación con contratos reales anonimizados para medir precisión por campo y calibrar el umbral K04.

## 8. Ejecución

```bash
npm ci
npx tsx demo.ts          # buzón completo sin LLM (agrega --json)
npm test                 # 15 pruebas
npm run dev              # http://localhost:3000 (sin API key arranca en modo sin LLM)
```
Variables: `ANTHROPIC_API_KEY`, `MODEL` (opcional), `SIGNING_SECRET` (recomendada), `FECHA_CORTE` y `UMBRAL_CONFIANZA` (opcionales).
