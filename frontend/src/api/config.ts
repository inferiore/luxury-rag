// VITE_API_BASE_URL es configurable vía rag/frontend/.env (ver .env.example).
// No hardcodear el host del backend en ningún otro lugar del código.
export const API_BASE_URL: string =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';
