import { Test, TestingModule } from '@nestjs/testing';
import { ChunksService, flattenToText } from './chunks.service';
import { ChunksRepository } from './chunks.repository';

describe('ChunksService', () => {
  let service: ChunksService;
  let repository: jest.Mocked<ChunksRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChunksService,
        {
          provide: ChunksRepository,
          useValue: { create: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(ChunksService);
    repository = module.get(ChunksRepository);
  });

  describe('flattenToText', () => {
    it('aplana un item con schema de tour (compatibilidad con v1)', () => {
      const item = {
        nombre: 'Tour Guatapé + Peñol',
        precio_publico: 180000,
        ciudad: 'Medellín',
      };

      const content = flattenToText(item);

      expect(content).toBe(
        'nombre: Tour Guatapé + Peñol. precio_publico: 180000. ciudad: Medellín.',
      );
    });

    it('aplana un item de un schema completamente distinto (e-commerce)', () => {
      const item = {
        sku: 'ABC-123',
        titulo: 'Silla ergonómica',
        precio: 450000,
        specs: { color: 'negro', material: 'malla' },
      };

      const content = flattenToText(item);

      expect(content).toBe(
        'sku: ABC-123. titulo: Silla ergonómica. precio: 450000. specs.color: negro. specs.material: malla.',
      );
    });

    it('omite valores null/undefined/string vacío', () => {
      const item = { a: 'x', b: null, c: undefined, d: '' };

      const content = flattenToText(item);

      expect(content).toBe('a: x.');
    });

    it('une un array de primitivos en una sola línea separada por comas', () => {
      const item = { tags: ['oficina', 'ergonomico', 'premium'] };

      const content = flattenToText(item);

      expect(content).toBe('tags: oficina, ergonomico, premium.');
    });

    it('recursa un array de objetos con prefijo [i]', () => {
      const item = {
        servicios: [{ nombre: 'Transporte' }, { nombre: 'Almuerzo' }],
      };

      const content = flattenToText(item);

      expect(content).toBe(
        'servicios[0].nombre: Transporte. servicios[1].nombre: Almuerzo.',
      );
    });

    it('devuelve string vacío para un objeto sin datos serializables', () => {
      expect(flattenToText({})).toBe('');
      expect(flattenToText({ a: null, b: '' })).toBe('');
    });
  });

  describe('createChunk', () => {
    it('delega la creación al repository con rawData y el content aplanado', async () => {
      const item = { sku: 'ABC-123', precio: 450000 };
      repository.create.mockResolvedValue({ id: 'chunk-uuid' } as any);

      const chunk = await service.createChunk('doc-uuid', item);

      expect(repository.create).toHaveBeenCalledWith({
        documentId: 'doc-uuid',
        rawData: item,
        content: 'sku: ABC-123. precio: 450000.',
      });
      expect(chunk).toEqual({ id: 'chunk-uuid' });
    });
  });
});
