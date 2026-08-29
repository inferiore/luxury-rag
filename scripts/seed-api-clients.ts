import { randomBytes } from 'crypto';
import AppDataSource from '../src/database/data-source';
import { ApiClient } from '../src/modules/auth/entities/api-client.entity';
import { hashApiKey } from '../src/modules/auth/api-key-hash.util';

// No hace falta dotenv.config() aquí: importar data-source.ts ya lo corre
// como side effect (ver ese archivo).

interface ClientSeed {
  name: string;
  queryLimitPerWindow: number | null;
  queryWindowSeconds: number | null;
  uploadLimitPerWindow: number | null;
  uploadWindowSeconds: number | null;
}

const CLIENTS: ClientSeed[] = [
  {
    name: 'demo-frontend',
    queryLimitPerWindow: 1,
    queryWindowSeconds: 300, // 1 por 5 minutos
    uploadLimitPerWindow: 1,
    uploadWindowSeconds: 1800, // 1 por 30 minutos
  },
  {
    name: 'luxury-agent-tour-specialist',
    queryLimitPerWindow: null,
    queryWindowSeconds: null,
    uploadLimitPerWindow: null,
    uploadWindowSeconds: null,
  },
];

async function main() {
  await AppDataSource.initialize();
  const repository = AppDataSource.getRepository(ApiClient);

  for (const seed of CLIENTS) {
    const existing = await repository.findOne({ where: { name: seed.name } });
    if (existing) {
      console.log(`Cliente '${seed.name}' ya existe — nada que hacer.`);
      continue;
    }

    const rawKey = randomBytes(32).toString('hex');
    const client = repository.create({
      name: seed.name,
      apiKeyHash: hashApiKey(rawKey),
      isActive: true,
      queryLimitPerWindow: seed.queryLimitPerWindow,
      queryWindowSeconds: seed.queryWindowSeconds,
      uploadLimitPerWindow: seed.uploadLimitPerWindow,
      uploadWindowSeconds: seed.uploadWindowSeconds,
    });
    await repository.save(client);

    console.log(`\nCliente '${seed.name}' creado.`);
    console.log(
      'API key (cópiala ahora — solo se guarda el hash, no se puede recuperar de nuevo):',
    );
    console.log(rawKey);
  }

  await AppDataSource.destroy();
}

main().then(() => process.exit(0));
