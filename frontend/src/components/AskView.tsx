import { useMutation } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { askQuestion } from '../api/query';
import { ApiError } from '../api/types';
import { useAppStore } from '../store/appStore';

export function AskView() {
  const question = useAppStore((s) => s.question);
  const setQuestion = useAppStore((s) => s.setQuestion);

  const mutation = useMutation({
    mutationFn: (q: string) => askQuestion(q),
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) return;
    mutation.mutate(trimmed);
  }

  return (
    <section className="panel">
      <h2>Preguntar sobre el catálogo</h2>
      <p className="panel-hint">Escribe una pregunta sobre los tours ya cargados.</p>

      <form onSubmit={handleSubmit} className="field-row">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="¿Cuánto cuesta el tour a Guatapé?"
          disabled={mutation.isPending}
        />
        <button type="submit" disabled={!question.trim() || mutation.isPending}>
          {mutation.isPending ? 'Preguntando…' : 'Preguntar'}
        </button>
      </form>

      {mutation.isPending && (
        <p className="status status-loading" role="status">
          Buscando en el catálogo…
        </p>
      )}

      {mutation.isSuccess && mutation.data.matched && (
        <div className="status status-success" role="status">
          <p>{mutation.data.answer}</p>
        </div>
      )}

      {mutation.isSuccess && !mutation.data.matched && (
        <div className="status status-info" role="status">
          <p>No encontramos información sobre eso en el catálogo.</p>
        </div>
      )}

      {mutation.isError && (
        <p className="status status-error" role="alert">
          {mutation.error instanceof ApiError
            ? mutation.error.message
            : 'Ocurrió un error inesperado al consultar.'}
        </p>
      )}
    </section>
  );
}
