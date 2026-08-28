# 06 — Frontend React

## Estado
Implementado

Validado: 2026-08-27 — PASS 7/7 criterios. Ver `rag/specs/validations/06-frontend-react.validation.md`.

**Nota de implementación (confirmada por Eder, no afecta criterios de aceptación):** la sección "Diseño técnico" sugería `useState`/`useEffect` sin librería de estado global; la implementación final usó Zustand + TanStack React Query en su lugar. También se omitió intencionalmente la paleta corporativa de Luxury Horizon (`--midnight`/`--golden`, Cormorant Garamond + Jost) por tratarse de un panel interno/de prueba. Ninguno de los 7 criterios numerados exigía lo contrario; el validador confirmó que ambas decisiones están realmente en uso y no violan ningún criterio.

## Contexto y objetivo

Con los dos endpoints públicos ya funcionando (`POST /documents/upload` de la spec 02, `POST /query` de la spec 04), esta spec construye la interfaz web que Eder va a usar día a día: subir el catálogo de tours en JSON, y hacer preguntas sobre él. El frontend es un proyecto independiente en `rag/frontend/`, sin lógica de negocio propia — solo llama a esos dos endpoints y muestra sus respuestas.

**Decisión pendiente de Eder** (no bloquea el resto de la spec, pero debe resolverse antes de implementar el estilo visual): ¿esta UI debe reusar la identidad de marca de Luxury Horizon (paleta `--midnight`/`--golden`, fuentes Cormorant Garamond + Jost), o es una herramienta interna sin necesidad de esa identidad? `react-rag-frontend` debe preguntarlo explícitamente si no está definido al momento de implementar.

## Diseño técnico

- Proyecto Vite + React + TypeScript en `rag/frontend/`, `package.json` propio, independiente del build del backend NestJS.
- `VITE_API_BASE_URL` (env, ej. `http://localhost:3000`) — todas las llamadas HTTP usan esta base.
- Dos vistas/componentes principales:
  - **`UploadView`**: input de archivo (acepta `.json`), botón de envío que hace `POST /documents/upload` (`multipart/form-data`, campo `file`). Mientras se sube: estado de carga. Al recibir 202: mostrar `documentId` y `totalItems` como confirmación (aclarando que el procesamiento sigue en background, sin prometer que ya está listo para preguntar). En error (400/500): mostrar el mensaje de error del backend.
  - **`AskView`**: input de texto para la pregunta + botón "Preguntar", hace `POST /query` con `{question}` (topK se deja en el default del backend, sin exponer el parámetro en la UI a menos que Eder lo pida). Muestra la respuesta:
    - `matched: true` → mostrar `answer` como respuesta normal del asistente.
    - `matched: false` → mostrar un estado informativo distinto (no un error), ej. "No encontramos información sobre eso en el catálogo".
    - Error de red/servidor real → estado de error distinto a los dos anteriores.
- Sin gestión de estado global (Redux/Zustand) — `useState`/`useEffect` de React alcanzan para dos vistas simples.
- Sin lógica de negocio del lado del cliente: no se calculan precios, descuentos ni nada que no venga ya resuelto en la respuesta del backend.

## Contratos de API

Reutiliza exactamente los contratos ya definidos en `02-upload-y-chunking-job.md` y `04-query-endpoint.md` — esta spec no los modifica, solo los consume.

## Esquema de datos

N/A — el frontend no tiene persistencia propia.

## Criterios de aceptación

1. `npm run dev` en `rag/frontend/` sirve una página con un formulario de subida de archivo y una vista de pregunta/respuesta.
2. Subir un archivo JSON válido de tours dispara una llamada real a `POST /documents/upload` (verificable en la pestaña de red del navegador) y la UI muestra `documentId`/`totalItems` devueltos por el backend.
3. Preguntar algo que coincide con un tour ya cargado y embebido muestra la respuesta real del backend (`answer`), no un placeholder.
4. Preguntar algo sin relación con el catálogo muestra el estado "no encontrado" con un estilo visual distinto al de una respuesta normal, y distinto al de un error de red.
5. Detener el backend y hacer una pregunta muestra un estado de error claramente distinguible del estado "no encontrado" (mensajes/estilos distintos).
6. Revisión de código: ningún componente del frontend calcula precios, descuentos, ni transforma datos de negocio más allá de formateo de presentación (ej. formato de moneda) — toda esa lógica vive en el backend.
7. `VITE_API_BASE_URL` es configurable vía `rag/frontend/.env.example` y no está hardcodeada en el código.
