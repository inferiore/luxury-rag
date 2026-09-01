import * as Joi from 'joi';

/**
 * Validation schema for environment variables.
 * Postgres variables are required — the app must not start without them.
 * Everything else has a sane default matching rag/.env.example.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),

  // --- Postgres (required) ---
  POSTGRES_HOST: Joi.string().required(),
  POSTGRES_PORT: Joi.number().required(),
  POSTGRES_USER: Joi.string().required(),
  POSTGRES_PASSWORD: Joi.string().required(),
  POSTGRES_DB: Joi.string().required(),
  POSTGRES_SSL: Joi.boolean().default(false),

  VECTOR_DIM: Joi.number().default(1536),

  // --- Selección de proveedor LLM ---
  // "gemini" usa el SDK oficial de Google (@google/genai) contra Vertex AI
  // Express Mode — a diferencia de "openai" apuntando a Gemini vía su
  // endpoint OpenAI-compatible, el SDK maneja automáticamente los
  // `thoughtSignature` que Gemini exige en tool-calling multi-turno (ver
  // GeminiProvider). No usa BASE_URL (el SDK resuelve el endpoint solo).
  LLM_PROVIDER: Joi.string()
    .valid('ollama', 'openai', 'gemini')
    .default('ollama'),

  // --- Config compartida del proveedor LLM activo (Ollama, OpenAI-compatible o Gemini) ---
  // BASE_URL/CHAT_MODEL/EMBEDDING_MODEL/LLM_API_KEY sirven para cualquiera
  // de los providers según LLM_PROVIDER — un .env solo corre un provider a
  // la vez, así que no hace falta duplicar el nombre por proveedor.
  // LLM_API_KEY no aplica a Ollama (no usa auth); BASE_URL no aplica a
  // Gemini (el SDK no lo necesita).
  BASE_URL: Joi.string()
    .default('http://localhost:11434')
    .when('LLM_PROVIDER', { is: 'openai', then: Joi.string().required() }),
  CHAT_MODEL: Joi.string()
    .default('qwen3:8b')
    .when('LLM_PROVIDER', {
      is: Joi.valid('openai', 'gemini'),
      then: Joi.string().required(),
    }),
  EMBEDDING_MODEL: Joi.string()
    .default('qwen3-embedding')
    .when('LLM_PROVIDER', {
      is: Joi.valid('openai', 'gemini'),
      then: Joi.string().required(),
    }),
  LLM_API_KEY: Joi.string()
    .allow('')
    .when('LLM_PROVIDER', {
      is: Joi.valid('openai', 'gemini'),
      then: Joi.string().required(),
    }),

  // --- Validación de /documents/upload (spec 02 v2) ---
  MAX_UPLOAD_ITEMS: Joi.number().default(2000),
  MAX_ITEM_DEPTH: Joi.number().default(6),
  MAX_ITEM_SIZE_BYTES: Joi.number().default(100000),

  // --- /query behavior ---
  DEFAULT_TOP_K: Joi.number().default(5),
  SIMILARITY_THRESHOLD: Joi.number().default(0.4),

  // --- Langfuse ---
  LANGFUSE_PUBLIC_KEY: Joi.string().allow('').optional(),
  LANGFUSE_SECRET_KEY: Joi.string().allow('').optional(),
  // Sin .default() a propósito: el default final vive en configuration.ts
  // como último eslabón del `??` (LANGFUSE_HOST ?? LANGFUSE_BASE_URL ??
  // default). Si Joi le pusiera un default aquí, @nestjs/config lo
  // escribiría en process.env.LANGFUSE_HOST antes de que configuration.ts
  // lo lea, neutralizando el alias LANGFUSE_BASE_URL (spec 09, bug 1).
  LANGFUSE_HOST: Joi.string().optional(),

  // --- Bold Payments (opcional — si BOLD_API_KEY no está configurada, la
  // herramienta create_payment_link no se ofrece al modelo, /query sigue
  // funcionando en modo solo-RAG, igual que Langfuse) ---
  BOLD_API_KEY: Joi.string().allow('').optional(),
  BOLD_BASE_URL: Joi.string().default('https://integrations.api.bold.co'),
  BOLD_MAX_AMOUNT_COP: Joi.number().default(5_000_000),
  BOLD_MIN_AMOUNT_COP: Joi.number().default(1_000),
  BOLD_LINK_EXPIRATION_HOURS: Joi.number().default(24),

  // --- CORS ---
  CORS_ORIGINS: Joi.string().default('http://localhost:5173'),
});
