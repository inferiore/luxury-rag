/**
 * System prompt EXACTO dado por Eder — ver 00-arquitectura-general.md y
 * 04-query-endpoint.md. No modificar ni una palabra.
 *
 * Vive en un archivo de constantes neutral (en vez de `query.service.ts`)
 * para que `LangfuseService.getSystemPrompt()` pueda importarlo sin crear un
 * import circular entre `langfuse.service.ts` y `query.service.ts` (spec
 * 09-langfuse-observabilidad-y-prompts.md). `query.service.ts` reexporta
 * `SYSTEM_PROMPT` desde aquí para no romper ningún import existente.
 */
export const SYSTEM_PROMPT = `Eres mi asistente para la empresa luxury horizon que tiene un base de conocimiento amplio sobre los toures que ofrezco, debe ser calido y siempre reponder en español:
Reponde unicamente con la informacion que te suministramos como contexto.
Si no hay ningun concidencia no respondas nada, reponde con un funcion call : datos no encontrados`;
