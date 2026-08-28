import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useRef } from 'react';
import { uploadTours } from '../api/documents';
import { ApiError } from '../api/types';
import { useAppStore } from '../store/appStore';

export function UploadView() {
  const selectedFile = useAppStore((s) => s.selectedFile);
  const setSelectedFile = useAppStore((s) => s.setSelectedFile);
  const lastUpload = useAppStore((s) => s.lastUpload);
  const setLastUpload = useAppStore((s) => s.setLastUpload);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (file: File) => uploadTours(file),
    onSuccess: (data) => {
      setLastUpload(data);
      // La tabla de documentos (DocumentsView) necesita enterarse del nuevo
      // documento para empezar a pollear su estado (pending/processing) —
      // ver rag/specs/08-documentos-chunks-retry.md, criterio 27.
      queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setLastUpload(null);
    mutation.reset();
  }

  function handleSubmit() {
    if (!selectedFile) return;
    mutation.mutate(selectedFile);
  }

  function handleReset() {
    setSelectedFile(null);
    setLastUpload(null);
    mutation.reset();
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  const errorMessage =
    mutation.isError &&
    (mutation.error instanceof ApiError
      ? mutation.error.message
      : 'Ocurrió un error inesperado al subir el archivo.');

  return (
    <section className="panel">
      <h2>Subir catálogo de tours</h2>
      <p className="panel-hint">
        Selecciona un archivo <code>.json</code> con el array de tours y súbelo al sistema.
      </p>

      <div className="field-row">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleFileChange}
          disabled={mutation.isPending}
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!selectedFile || mutation.isPending}
        >
          {mutation.isPending ? 'Subiendo…' : 'Subir'}
        </button>
        {(selectedFile || lastUpload || mutation.isError) && (
          <button type="button" className="secondary" onClick={handleReset} disabled={mutation.isPending}>
            Limpiar
          </button>
        )}
      </div>

      {mutation.isPending && (
        <p className="status status-loading" role="status">
          Subiendo archivo y creando el documento…
        </p>
      )}

      {mutation.isSuccess && lastUpload && (
        <div className="status status-success" role="status">
          <p>
            <strong>Archivo recibido.</strong> El procesamiento sigue en segundo plano
            (todavía puede tardar en estar listo para responder preguntas).
          </p>
          <dl className="kv">
            <dt>documentId</dt>
            <dd>{lastUpload.documentId}</dd>
            <dt>totalItems</dt>
            <dd>{lastUpload.totalItems}</dd>
            <dt>status</dt>
            <dd>{lastUpload.status}</dd>
          </dl>
        </div>
      )}

      {errorMessage && (
        <p className="status status-error" role="alert">
          {errorMessage}
        </p>
      )}
    </section>
  );
}
