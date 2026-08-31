import * as dotenv from 'dotenv';
import { LangfuseClient } from '@langfuse/client';
import { SYSTEM_PROMPT } from '../src/modules/query/query.service';

// Corre fuera del contexto de Nest (igual que src/database/data-source.ts),
// así que necesita cargar .env explícitamente antes de leer
// process.env.LANGFUSE_* — sin esto, las credenciales llegan undefined,
// Langfuse responde 401 y el catch de getPrompt lo interpreta como
// "no existe", reportando un falso "creado" (spec 09, bug 2).
dotenv.config();

const PROMPT_NAME = 'query-system-prompt';

async function main() {
  const client = new LangfuseClient({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_HOST ?? process.env.LANGFUSE_BASE_URL,
  });

  let existing;
  try {
    existing = await client.prompt.get(PROMPT_NAME, {
      label: 'production',
      type: 'text',
    });
  } catch {
    existing = null;
  }

  if (!existing) {
    await client.prompt.create({
      type: 'text',
      name: PROMPT_NAME,
      prompt: SYSTEM_PROMPT,
      labels: ['production'],
    });
    console.log(`Prompt '${PROMPT_NAME}' creado en Langfuse (v1).`);
    return;
  }

  if (existing.prompt !== SYSTEM_PROMPT) {
    console.warn(
      `El prompt '${PROMPT_NAME}' ya existe en Langfuse y su texto ` +
        'difiere de la constante SYSTEM_PROMPT actual en el código. ' +
        'NO se sobrescribe automáticamente — reconcilia manualmente en ' +
        'el dashboard de Langfuse o actualiza SYSTEM_PROMPT si el ' +
        'texto remoto es el correcto.',
    );
    return;
  }

  console.log(`Prompt '${PROMPT_NAME}' ya existe y coincide — nada que hacer.`);
}

main().then(() => process.exit(0));
