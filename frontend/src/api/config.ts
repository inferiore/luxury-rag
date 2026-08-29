// VITE_API_BASE_URL es configurable vía rag/frontend/.env (ver .env.example).
// No hardcodear el host del backend en ningún otro lugar del código.
export const API_BASE_URL: string =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

// Key del cliente "demo-frontend" (ver rag/scripts/seed-api-clients.ts).
// El backend exige Authorization: Bearer <key> en todas las rutas excepto
// /health — sin esto todas las llamadas de este frontend reciben 401.
export const API_KEY: string = import.meta.env.VITE_API_KEY ?? '';

export function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${API_KEY}` };
}
