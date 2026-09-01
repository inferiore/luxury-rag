import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { BoldPaymentsService } from './bold-payments.service';

describe('BoldPaymentsService', () => {
  let service: BoldPaymentsService;
  const originalFetch = global.fetch;

  const configValues: Record<string, unknown> = {
    'boldPayments.apiKey': 'bold-test-key',
    'boldPayments.baseUrl': 'https://integrations.api.bold.co',
    'boldPayments.maxAmountCop': 5_000_000,
    'boldPayments.minAmountCop': 1_000,
    'boldPayments.linkExpirationHours': 24,
  };

  const buildService = async (
    overrides: Record<string, unknown> = {},
  ): Promise<BoldPaymentsService> => {
    const values = { ...configValues, ...overrides };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BoldPaymentsService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string) => values[key]) },
        },
      ],
    }).compile();
    return module.get(BoldPaymentsService);
  };

  beforeEach(async () => {
    service = await buildService();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('isEnabled() es true si BOLD_API_KEY está configurada', () => {
    expect(service.isEnabled()).toBe(true);
  });

  it('isEnabled() es false si BOLD_API_KEY está vacía', async () => {
    const disabled = await buildService({ 'boldPayments.apiKey': '' });
    expect(disabled.isEnabled()).toBe(false);
  });

  it('createPaymentLink() llama a Bold con amount_type CLOSE, currency COP fijos y header x-api-key', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          payload: {
            payment_link: 'LNK_H7S4xxx',
            url: 'https://checkout.bold.co/LNK_H7S4xxx',
          },
          errors: [],
        }),
    });
    global.fetch = fetchMock;

    const result = await service.createPaymentLink({
      description: 'Tour Guatapé',
      amountCop: 180000,
    });

    expect(result).toEqual({
      url: 'https://checkout.bold.co/LNK_H7S4xxx',
      paymentLink: 'LNK_H7S4xxx',
    });

    const [url, requestInit] = fetchMock.mock.calls[0];
    expect(url).toBe('https://integrations.api.bold.co/online/link/v1');
    expect(
      (requestInit as { headers: Record<string, string> }).headers,
    ).toEqual(
      expect.objectContaining({ Authorization: 'x-api-key bold-test-key' }),
    );
    const body = JSON.parse((requestInit as { body: string }).body) as {
      amount_type: string;
      amount: { currency: string; total_amount: number };
      description: string;
    };
    expect(body.amount_type).toBe('CLOSE');
    expect(body.amount).toEqual({ currency: 'COP', total_amount: 180000 });
    expect(body.description).toBe('Tour Guatapé');
  });

  it('lanza si Bold responde HTTP no-ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal error'),
    });

    await expect(
      service.createPaymentLink({ description: 'Tour X', amountCop: 10000 }),
    ).rejects.toThrow(/Bold \/online\/link\/v1 respondió 500/);
  });

  it('lanza si falla la conexión con Bold', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      service.createPaymentLink({ description: 'Tour X', amountCop: 10000 }),
    ).rejects.toThrow(/No se pudo conectar con Bold/);
  });

  it('lanza si Bold responde 200 pero con errors no vacío', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          payload: { payment_link: '', url: '' },
          errors: [{ code: 'x' }],
        }),
    });

    await expect(
      service.createPaymentLink({ description: 'Tour X', amountCop: 10000 }),
    ).rejects.toThrow(/Bold devolvió errores/);
  });

  it('rechaza un monto por encima de BOLD_MAX_AMOUNT_COP sin llamar a fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    await expect(
      service.createPaymentLink({
        description: 'Tour X',
        amountCop: 999_999_999,
      }),
    ).rejects.toThrow(/El monto debe ser un entero entre/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rechaza un monto por debajo de BOLD_MIN_AMOUNT_COP sin llamar a fetch', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    await expect(
      service.createPaymentLink({ description: 'Tour X', amountCop: 1 }),
    ).rejects.toThrow(/El monto debe ser un entero entre/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('crea el link sin descripción (undefined) y la omite del body enviado a Bold', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          payload: {
            payment_link: 'LNK_1',
            url: 'https://checkout.bold.co/LNK_1',
          },
          errors: [],
        }),
    });
    global.fetch = fetchMock;

    const result = await service.createPaymentLink({ amountCop: 10000 });

    expect(result).toEqual({
      url: 'https://checkout.bold.co/LNK_1',
      paymentLink: 'LNK_1',
    });
    const [, requestInit] = fetchMock.mock.calls[0];
    const body = JSON.parse((requestInit as { body: string }).body) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty('description');
  });
});
