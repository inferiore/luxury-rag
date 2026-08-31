import * as dotenv from 'dotenv';
// Debe cargarse antes de leer `process.env.LANGFUSE_*` más abajo — este
// archivo se importa como primera línea de `main.ts`, antes de que Nest
// arranque `ConfigModule` (que es quien normalmente carga `.env`). Mismo
// problema y misma solución que en `scripts/seed-langfuse-prompt.ts` y
// `src/database/data-source.ts`.
dotenv.config();

import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import configuration from './config/configuration';

const { langfuse } = configuration();

const langfuseTracingEnabled = Boolean(
  langfuse.publicKey && langfuse.secretKey,
);

if (!langfuseTracingEnabled) {
  console.warn(
    'LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY no configuradas — tracing deshabilitado',
  );
}

// Todas las observaciones de esta app se crean manualmente con
// `startObservation` de `@langfuse/tracing` (ver `query.service.ts`), no hay
// auto-instrumentación de terceros — por eso no hace falta `instrumentations`
// ni sobreescribir `shouldExportSpan`: el filtro por defecto de v5 ya exporta
// todo lo que crea el SDK de Langfuse.
const spanProcessor = langfuseTracingEnabled
  ? new LangfuseSpanProcessor({
      publicKey: langfuse.publicKey,
      secretKey: langfuse.secretKey,
      baseUrl: langfuse.host,
    })
  : undefined;

export const otelSdk = new NodeSDK({
  spanProcessors: spanProcessor ? [spanProcessor] : [],
});

otelSdk.start();

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await otelSdk.shutdown().catch(() => undefined);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
