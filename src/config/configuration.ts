export default () => {
  const llmProviderName = process.env.LLM_PROVIDER ?? 'ollama';

  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '3000', 10),
    database: {
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      ssl: process.env.POSTGRES_SSL === 'true',
    },
    llm: {
      provider: llmProviderName,
      baseUrl: process.env.BASE_URL ?? 'http://localhost:11434',
      apiKey: process.env.LLM_API_KEY ?? '',
      chatModel: process.env.CHAT_MODEL ?? 'qwen3:8b',
      embeddingModel: process.env.EMBEDDING_MODEL ?? 'qwen3-embedding',
    },
    vectorDim: parseInt(process.env.VECTOR_DIM ?? '1536', 10),
    upload: {
      maxItems: parseInt(process.env.MAX_UPLOAD_ITEMS ?? '2000', 10),
      maxItemDepth: parseInt(process.env.MAX_ITEM_DEPTH ?? '6', 10),
      maxItemSizeBytes: parseInt(
        process.env.MAX_ITEM_SIZE_BYTES ?? '100000',
        10,
      ),
    },
    query: {
      defaultTopK: parseInt(process.env.DEFAULT_TOP_K ?? '1', 10),
      similarityThreshold: parseFloat(
        process.env.SIMILARITY_THRESHOLD ?? '0.4',
      ),
    },
    langfuse: {
      publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? '',
      secretKey: process.env.LANGFUSE_SECRET_KEY ?? '',
      host:
        process.env.LANGFUSE_HOST ??
        process.env.LANGFUSE_BASE_URL ??
        'https://cloud.langfuse.com',
      usingDeprecatedHostAlias:
        !process.env.LANGFUSE_HOST && !!process.env.LANGFUSE_BASE_URL,
    },
  };
};
