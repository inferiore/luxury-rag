import { stripThinkTags } from './strip-think-tags';

describe('stripThinkTags', () => {
  it('elimina un bloque <think> completo y devuelve el resto trimmeado', () => {
    const input =
      '<think>el usuario pregunta por el precio, debo responder con el contexto</think>El tour cuesta $180.000 COP.';
    expect(stripThinkTags(input)).toBe('El tour cuesta $180.000 COP.');
  });

  it('elimina bloques <think> multilínea', () => {
    const input = `<think>
      razonamiento largo
      con varias líneas
    </think>
    Respuesta final.`;
    expect(stripThinkTags(input)).toBe('Respuesta final.');
  });

  it('elimina múltiples bloques <think>', () => {
    const input = '<think>uno</think>Parte A.<think>dos</think>Parte B.';
    expect(stripThinkTags(input)).toBe('Parte A.Parte B.');
  });

  it('descarta un bloque <think> sin cerrar hasta el final del texto', () => {
    const input = 'Respuesta parcial. <think>razonamiento que no terminó...';
    expect(stripThinkTags(input)).toBe('Respuesta parcial.');
  });

  it('deja el texto intacto si no hay bloques <think>', () => {
    expect(stripThinkTags('datos no encontrados')).toBe('datos no encontrados');
  });

  it('devuelve string vacío si recibe input vacío', () => {
    expect(stripThinkTags('')).toBe('');
  });
});
