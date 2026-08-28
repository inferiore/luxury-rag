import configuration from './configuration';

// `configuration` es una factory (`() => ({...})`) que lee `process.env` en
// el momento en que se invoca, no al importar el módulo — no hace falta
// `jest.resetModules()`/`require` dinámico, basta con mutar `process.env`
// antes de llamar a `configuration()` en cada test.
describe('configuration — langfuse.host resolution (spec 09)', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.LANGFUSE_HOST;
    delete process.env.LANGFUSE_BASE_URL;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('usa LANGFUSE_BASE_URL como fallback y marca usingDeprecatedHostAlias cuando LANGFUSE_HOST no está definida (criterio 1)', () => {
    process.env.LANGFUSE_BASE_URL = 'https://us.cloud.langfuse.com';

    const config = configuration();

    expect(config.langfuse.host).toBe('https://us.cloud.langfuse.com');
    expect(config.langfuse.usingDeprecatedHostAlias).toBe(true);
  });

  it('prioriza LANGFUSE_HOST sobre LANGFUSE_BASE_URL cuando ambas están definidas, sin marcar alias deprecado (criterio 2)', () => {
    process.env.LANGFUSE_HOST = 'https://cloud.langfuse.com';
    process.env.LANGFUSE_BASE_URL = 'https://us.cloud.langfuse.com';

    const config = configuration();

    expect(config.langfuse.host).toBe('https://cloud.langfuse.com');
    expect(config.langfuse.usingDeprecatedHostAlias).toBe(false);
  });

  it('usa el default https://cloud.langfuse.com cuando ninguna variable está definida, sin alias deprecado (criterio 3)', () => {
    const config = configuration();

    expect(config.langfuse.host).toBe('https://cloud.langfuse.com');
    expect(config.langfuse.usingDeprecatedHostAlias).toBe(false);
  });
});
