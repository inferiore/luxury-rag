# Validación — 06-frontend-react

Fecha: 2026-08-27
Veredicto general: PASS (7/7 criterios)

## Entorno de prueba

- Backend: `docker compose -f rag/docker-compose.yml up` — `rag-app` (puerto 3000) y `rag-postgres` (puerto 5432), ambos `healthy`.
- Frontend: `rag/frontend/`, `npm run dev -- --port 5173 --strictPort` (Vite 8.2.2) y adicionalmente `npm run build` para el criterio de build de producción.
- Navegador real: Chromium 1234 (cache de Playwright en `~/Library/Caches/ms-playwright`), automatizado con `playwright@1.62.1` instalado temporalmente en el scratchpad de esta sesión (no se tocó `rag/frontend/node_modules`).
- Fixtures usados (no tocan el catálogo real): `tours-validos.json` con un único tour distintivo `"Tour QA Validacion Zeta9981"` (nombre único para poder identificarlo y borrarlo después) y `tours-invalidos.json` con un item sin `nombre`. Ambos en el scratchpad de la sesión.
- Estado de la base antes de la prueba: `documents=12`, `chunks=24`. Al terminar la prueba se verificó que quedó exactamente igual (`documents=12`, `chunks=24`) tras borrar el documento de prueba (`ON DELETE CASCADE` se llevó también su chunk).

## Criterio 1: `npm run dev` en `rag/frontend/` sirve una página con un formulario de subida de archivo y una vista de pregunta/respuesta

**Resultado:** PASS
**Comando:**
```bash
cd rag/frontend && npm run dev -- --port 5173 --strictPort
curl -s http://localhost:5173/ -o /dev/null -w "%{http_code}\n"
```
**Evidencia:**
```
> frontend@0.0.0 dev
> vite --port 5173 --strictPort

  VITE v8.2.2  ready in 189 ms
  ➜  Local:   http://localhost:5173/
200
```
Con Playwright, al navegar a `http://localhost:5173/`:
```
"criterio1_page_title": "Luxury Horizon RAG — Panel interno"
"criterio1_has_upload_input": 1   // input[type=file] presente
"criterio1_has_question_input": 1 // input[type=text] presente
```
Screenshot: `01-initial-load.png` — se ven las dos secciones "Subir catálogo de tours" (`UploadView`) y "Preguntar sobre el catálogo" (`AskView`).

## Criterio 2: Subir un archivo JSON válido dispara una llamada real a `POST /documents/upload` (verificable en la pestaña de red) y la UI muestra `documentId`/`totalItems`

**Resultado:** PASS
**Comando:** Playwright — `setInputFiles('input[type=file]', tours-validos.json)` → click "Subir", con listeners de `page.on('request'/'response')` filtrando `localhost:3000`.
**Evidencia (network real capturada por el navegador):**
```
{ "type": "request",  "method": "POST", "url": "http://localhost:3000/documents/upload" }
{ "type": "response", "status": 202,    "url": "http://localhost:3000/documents/upload" }
```
**Texto renderizado en la UI:**
```
Archivo recibido. El procesamiento sigue en segundo plano
(todavía puede tardar en estar listo para responder preguntas).

documentId  33292a6b-49bd-497b-8e1d-0b2a36e72717
totalItems  1
status      processing
```
Confirmado contra la base de datos directamente (no solo confiando en la UI):
```bash
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT id, status, total_items FROM documents WHERE id='33292a6b-49bd-497b-8e1d-0b2a36e72717';"
```
```
                  id                  | status | total_items
--------------------------------------+--------+-------------
 33292a6b-49bd-497b-8e1d-0b2a36e72717 | done   |           1
```
El `documentId`/`totalItems` mostrados en la UI coinciden exactamente con la fila real en Postgres. Screenshot: `02-upload-valido.png`.

**Adicional (no numerado pero verificado por ser parte del mismo flujo):** upload de `tours-invalidos.json` (item sin `nombre`) → petición real `POST http://localhost:3000/documents/upload` con respuesta `400`, UI muestra `.status-error` con el mensaje exacto del backend: `"El item en la posición 0 no cumple la validación del campo 'nombre'"`. Sin bloqueo CORS (la petición se completa y el navegador recibe el body 400, prueba de que la spec 07-cors-configuration sigue vigente).

## Criterio 3: Preguntar algo que coincide con un tour cargado y embebido muestra la respuesta real del backend (`answer`), no un placeholder

**Resultado:** PASS
**Comando:** Se esperó ~8s tras el upload para que el job de chunking+embedding terminara, confirmado en DB:
```bash
docker exec rag-postgres psql -U rag_user -d rag_db -c \
  "SELECT nombre, status, embedding IS NOT NULL AS has_embedding FROM chunks WHERE document_id='33292a6b-...';"
```
```
           nombre            | status | has_embedding
------------------------------+--------+---------------
 Tour QA Validacion Zeta9981  | done   | t
```
Luego, en el navegador: se escribió `"Cuéntame sobre el Tour QA Validacion Zeta9981"` en el input de `AskView` y se hizo click en "Preguntar".
**Evidencia — respuesta real capturada de `POST http://localhost:3000/query` (status 200):**
```json
{
  "answer": "El **Tour QA Validacion Zeta9981** es un recorrido de prueba para validar la especificación 06 del frontend React, y no es un tour real. El precio es de **999.000 COP / 250 USD**. El lugar de embarque es el **Hotel de pruebas QA**, y el destino es la **Isla de Pruebas, QAtestlandia**.",
  "matched": true
}
```
UI renderiza exactamente ese `answer` (no un placeholder genérico) dentro de `.status-success`. Screenshot: `04-ask-match.png`.

## Criterio 4: Preguntar algo sin relación con el catálogo muestra el estado "no encontrado" con estilo visual distinto al de una respuesta normal y distinto al de un error de red

**Resultado:** PASS
**Comando:** En `AskView`, se preguntó `"Cual es la capital de la luna en el año 3000 xyz987 pregunta sin relacion"`.
**Evidencia — respuesta real del backend:**
```json
{ "answer": "datos no encontrados", "matched": false }
```
**UI:**
```
"criterio4_class": "status status-info"
"criterio4_role": "status"
"criterio4_text": "No encontramos información sobre eso en el catálogo."
```
Clase CSS (`status-info`) y rol (`role="status"`) distintos de la respuesta normal (`status-success`, criterio 3) y del error (`status-error`, `role="alert"`, criterio 5). Screenshot: `05-ask-nomatch.png`.

## Criterio 5: Detener el backend y hacer una pregunta muestra un estado de error claramente distinguible del estado "no encontrado"

**Resultado:** PASS
**Comando:**
```bash
docker stop rag-app
# pregunta en la UI: "Pregunta cualquiera con backend caido test999"
docker start rag-app   # restaurado inmediatamente después de capturar evidencia
```
**Evidencia:**
```
"criterio5_class": "status status-error"
"criterio5_role": "alert"
"criterio5_text": "No se pudo conectar con el servidor. Verifica que el backend esté corriendo."
```
Clase (`status-error`) y rol (`role="alert"`) distintos del estado "no encontrado" (`status-info`/`role="status"`, criterio 4) y del de éxito (`status-success`). El código distingue explícitamente error de red real (fetch lanza excepción → `ApiError(..., status: null, isBackendError: false)`) de error HTTP del backend (`rag/frontend/src/api/query.ts`), aunque la UI en ambos casos usa `.status-error`. Screenshot: `06-backend-caido.png`.
Tras la prueba se confirmó `rag-app` de nuevo `healthy`:
```
docker ps --filter name=rag-app --format "{{.Status}}"
Up 33 seconds (healthy)
```

## Criterio 6: Revisión de código — ningún componente calcula precios/descuentos ni transforma datos de negocio más allá de formateo de presentación

**Resultado:** PASS
**Comando:**
```bash
grep -rn "precio\|toLocaleString\|Intl\|calcul\|descuento" rag/frontend/src/
```
**Evidencia:** sin resultados — ningún archivo del frontend referencia `precio`, cálculos, ni formateo de moneda. Se revisó manualmente:
- `src/components/UploadView.tsx` / `AskView.tsx`: solo llaman a `useMutation`, muestran `lastUpload.documentId/totalItems/status` y `mutation.data.answer/matched` tal cual vienen del backend.
- `src/api/documents.ts` / `src/api/query.ts`: solo hacen `fetch`, arman `FormData`/`JSON.stringify`, parsean la respuesta o el error — cero lógica de negocio.
- `src/api/types.ts`: solo interfaces que reflejan el contrato de las specs 02/04.

## Criterio 7: `VITE_API_BASE_URL` es configurable vía `.env.example` y no está hardcodeada

**Resultado:** PASS
**Comando:**
```bash
cat rag/frontend/.env.example
grep -rn "VITE_API_BASE_URL\|localhost:3000" rag/frontend/src/
```
**Evidencia:**
```
# rag/frontend/.env.example
VITE_API_BASE_URL=http://localhost:3000
```
```
src/api/config.ts:4:  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
```
El único literal `http://localhost:3000` en `src/` es el fallback de `config.ts` (comentado explícitamente como tal), usado únicamente si la env var no está definida — no hay URLs hardcodeadas dentro de `documents.ts`/`query.ts`, que importan `API_BASE_URL` desde `config.ts`.

## Verificaciones adicionales solicitadas (no numeradas en la spec, pero exigidas por el encargo)

### Uso real de Zustand (no solo dependencia sin usar)
```bash
grep -rn "zustand" rag/frontend/src/
```
```
src/store/appStore.ts:1:import { create } from 'zustand';
```
`src/store/appStore.ts` define un store real (`useAppStore`) con `selectedFile`, `lastUpload`, `question` y sus setters; `UploadView.tsx` y `AskView.tsx` lo consumen vía `useAppStore((s) => s.xxx)`.

### Uso real de TanStack React Query (no fetch/axios manual con useEffect)
```bash
grep -rn "@tanstack/react-query\|useMutation\|useQuery" rag/frontend/src/
grep -rn "useEffect\|axios" rag/frontend/src/
```
```
src/main.tsx:1:import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
src/components/AskView.tsx:1:import { useMutation } from '@tanstack/react-query';
src/components/AskView.tsx:11:  const mutation = useMutation({...});
src/components/UploadView.tsx:1:import { useMutation } from '@tanstack/react-query';
src/components/UploadView.tsx:14:  const mutation = useMutation({...});
```
`grep` de `useEffect`/`axios` no arrojó resultados — no hay llamadas HTTP manuales con `useEffect`, todas pasan por `useMutation`. `main.tsx` envuelve la app en `QueryClientProvider`.

Nota: la sección "Diseño técnico" de la spec (texto libre, no un criterio numerado) originalmente sugería `useState`/`useEffect` sin librería de estado global. Según el encargo de esta validación, Eder confirmó explícitamente el cambio de stack a Zustand + TanStack React Query, y ninguno de los 7 criterios de aceptación numerados prohíbe esas librerías — se validó que están realmente en uso (no como dependencias muertas) y que no violan ningún criterio numerado.

### Paleta corporativa / fuentes de Luxury Horizon
```bash
grep -rin "midnight\|golden\|cormorant\|jost" rag/frontend/src/ rag/frontend/index.html
```
Sin resultados. `src/index.css` define su propia paleta neutral (`--bg`, `--surface`, `--primary: #2f6fed`, etc.) y usa `font-family: system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif` — no hay `--midnight`/`--golden` ni Cormorant Garamond/Jost. Consistente con la decisión de Eder de "ambiente de prueba/interno sin la identidad de marca".

### Build de producción
**Comando:**
```bash
cd rag/frontend && npm run build
```
**Evidencia:**
```
> frontend@0.0.0 build
> tsc -b && vite build

vite v8.2.2 building client environment for production...
✓ 71 modules transformed.
dist/index.html                   0.48 kB
dist/assets/index-RLGxtvE_.css    2.25 kB
dist/assets/index-B1Sypmd8.js   223.25 kB
✓ built in 90ms
```
`tsc -b` no reportó errores de tipos; `vite build` generó el bundle sin advertencias.

## Estado final del sistema tras la validación

- `docker exec rag-postgres psql ... "SELECT count(*) FROM documents;"` → `12` (igual al conteo previo a la prueba).
- `docker exec rag-postgres psql ... "SELECT count(*) FROM chunks;"` → `24` (igual al conteo previo).
- Documento/chunk de prueba `33292a6b-49bd-497b-8e1d-0b2a36e72717` (`Tour QA Validacion Zeta9981`) borrado explícitamente (`DELETE FROM documents WHERE id=...`, cascada a `chunks`).
- `rag-app` y `rag-postgres`: ambos `healthy` en `docker ps`.
- Sin procesos de Chromium/Playwright colgados (`ps aux | grep chromium` vacío tras `browser.close()`).
- Servidor de dev de Vite en :5173 detenido (`kill` del proceso, puerto liberado, confirmado con `lsof -i :5173` vacío). Nota: al iniciar la validación ya existía un proceso `vite` huérfano en :5173 (de una sesión previa del agente implementador) — se detuvo también para dejar el entorno limpio.

## Conclusión

Los 7 criterios de aceptación numerados de la spec pasan con evidencia reproducible: navegador real (Chromium vía Playwright), peticiones HTTP reales capturadas en la pestaña de red, y verificación cruzada contra Postgres directamente (no solo confiando en lo que muestra la UI). Zustand y TanStack React Query están realmente en uso (no como dependencias muertas), no hay lógica de negocio del lado del cliente, no se usó la paleta/fuentes corporativas, `VITE_API_BASE_URL` es configurable, y `npm run build` compila sin errores.

Se sugiere a Eder que `rag-spec-planner` actualice el `Estado` de `rag/specs/06-frontend-react.md` a `Implementado`.
