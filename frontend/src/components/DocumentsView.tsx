import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDocumentChunks, retryChunk } from '../api/chunks';
import { getDocuments, retryFailedChunks } from '../api/documents';
import { ApiError, type ChunkListItemDto, type DocumentListItemDto } from '../api/types';
import { useAppStore } from '../store/appStore';

const POLL_INTERVAL_MS = 3000;

// El backend devuelve el mismo mensaje 409 genérico
// ("El documento <id> no tiene chunks en estado 'failed' para reintentar")
// tanto para "ya no quedan chunks failed" como para el caso límite documentado
// en la spec (documento `failed` con 0 chunks — el chunking falló antes de
// crear el primero). El botón "Reintentar fallidos" solo se muestra cuando
// `document.status === 'failed'`, así que en la práctica un 409 en este punto
// SIEMPRE corresponde al caso límite (ver rag/specs/08-documentos-chunks-retry.md,
// criterio 31) — por eso se traduce a ese mensaje exacto en vez del genérico del
// backend, que no distingue ambos casos.
const NO_CHUNKS_TO_RETRY_MESSAGE =
  'Este documento no tiene chunks para reintentar; debe volver a subirse.';

function retryFailedErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 409 ? NO_CHUNKS_TO_RETRY_MESSAGE : error.message;
  }
  return 'Ocurrió un error inesperado al reintentar los chunks fallidos.';
}

function isInProgress(status: string): boolean {
  return status === 'pending' || status === 'processing';
}

function StatusBadge({ status }: { status: string }) {
  const className =
    status === 'done'
      ? 'badge badge-success'
      : status === 'failed'
        ? 'badge badge-error'
        : 'badge badge-info';
  return <span className={className}>{status}</span>;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function PaginationControls({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="pagination">
      <button
        type="button"
        className="secondary"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
      >
        Anterior
      </button>
      <span className="pagination-label">
        página {page} de {Math.max(totalPages, 1)}
      </span>
      <button
        type="button"
        className="secondary"
        onClick={() => onChange(page + 1)}
        disabled={page >= totalPages}
      >
        Siguiente
      </button>
    </div>
  );
}

function ChunkRow({ documentId, chunk }: { documentId: string; chunk: ChunkListItemDto }) {
  const queryClient = useQueryClient();

  const retryMutation = useMutation({
    mutationFn: () => retryChunk(documentId, chunk.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['documentChunks', documentId] });
    },
  });

  return (
    <tr>
      <td className="chunk-content">{chunk.content}</td>
      <td>
        <StatusBadge status={chunk.status} />
      </td>
      <td className="chunk-error">
        {chunk.errorMessage && <span>{chunk.errorMessage}</span>}
      </td>
      <td>
        {chunk.status === 'failed' && (
          <button
            type="button"
            className="secondary"
            onClick={() => retryMutation.mutate()}
            disabled={retryMutation.isPending}
          >
            {retryMutation.isPending ? 'Reintentando…' : 'Reintentar'}
          </button>
        )}
        {retryMutation.isError && (
          <p className="status status-error chunk-retry-error" role="alert">
            {retryMutation.error instanceof ApiError
              ? retryMutation.error.message
              : 'Ocurrió un error inesperado al reintentar el chunk.'}
          </p>
        )}
      </td>
    </tr>
  );
}

function DocumentChunksPanel({ documentId }: { documentId: string }) {
  const chunksPage = useAppStore((s) => s.chunksPage);
  const setChunksPage = useAppStore((s) => s.setChunksPage);

  const chunksQuery = useQuery({
    queryKey: ['documentChunks', documentId, chunksPage],
    queryFn: () => getDocumentChunks(documentId, chunksPage),
    enabled: documentId !== null,
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const anyInProgress = data.items.some((chunk) => isInProgress(chunk.status));
      return anyInProgress ? POLL_INTERVAL_MS : false;
    },
  });

  if (chunksQuery.isPending) {
    return <p className="status status-loading">Cargando chunks…</p>;
  }

  if (chunksQuery.isError) {
    return (
      <p className="status status-error" role="alert">
        {chunksQuery.error instanceof ApiError
          ? chunksQuery.error.message
          : 'Ocurrió un error inesperado al cargar los chunks.'}
      </p>
    );
  }

  const data = chunksQuery.data;

  return (
    <div className="chunks-panel">
      <table className="data-table chunks-table">
        <thead>
          <tr>
            <th>Contenido</th>
            <th>Estado</th>
            <th>Error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {data.items.length === 0 && (
            <tr>
              <td colSpan={4} className="empty-row">
                Este documento no tiene chunks.
              </td>
            </tr>
          )}
          {data.items.map((chunk) => (
            <ChunkRow key={chunk.id} documentId={documentId} chunk={chunk} />
          ))}
        </tbody>
      </table>
      <PaginationControls page={data.page} totalPages={data.totalPages} onChange={setChunksPage} />
    </div>
  );
}

function DocumentRow({ document }: { document: DocumentListItemDto }) {
  const expandedDocumentId = useAppStore((s) => s.expandedDocumentId);
  const setExpandedDocumentId = useAppStore((s) => s.setExpandedDocumentId);
  const queryClient = useQueryClient();
  const isExpanded = expandedDocumentId === document.id;

  const retryFailedMutation = useMutation({
    mutationFn: () => retryFailedChunks(document.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['documents'] });
      queryClient.invalidateQueries({ queryKey: ['documentChunks', document.id] });
    },
  });

  return (
    <>
      <tr className="document-row" onClick={() => setExpandedDocumentId(document.id)}>
        <td>{document.originalFilename}</td>
        <td>{document.totalItems}</td>
        <td>
          <StatusBadge status={document.status} />
        </td>
        <td>{formatDate(document.createdAt)}</td>
        <td onClick={(e) => e.stopPropagation()}>
          {document.status === 'failed' && (
            <button
              type="button"
              className="secondary"
              onClick={() => retryFailedMutation.mutate()}
              disabled={retryFailedMutation.isPending}
            >
              {retryFailedMutation.isPending ? 'Reintentando…' : 'Reintentar fallidos'}
            </button>
          )}
        </td>
      </tr>
      {retryFailedMutation.isError && (
        <tr>
          <td colSpan={5}>
            <p className="status status-error" role="alert">
              {retryFailedErrorMessage(retryFailedMutation.error)}
            </p>
          </td>
        </tr>
      )}
      {isExpanded && (
        <tr className="chunks-panel-row">
          <td colSpan={5}>
            <DocumentChunksPanel documentId={document.id} />
          </td>
        </tr>
      )}
    </>
  );
}

export function DocumentsView() {
  const documentsPage = useAppStore((s) => s.documentsPage);
  const setDocumentsPage = useAppStore((s) => s.setDocumentsPage);

  const documentsQuery = useQuery({
    queryKey: ['documents', documentsPage],
    queryFn: () => getDocuments(documentsPage),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      const anyInProgress = data.items.some((doc) => isInProgress(doc.status));
      return anyInProgress ? POLL_INTERVAL_MS : false;
    },
  });

  return (
    <section className="panel">
      <h2>Documentos</h2>
      <p className="panel-hint">
        Documentos subidos y el estado de sus chunks. Haz clic en una fila para ver el detalle.
      </p>

      {documentsQuery.isPending && (
        <p className="status status-loading" role="status">
          Cargando documentos…
        </p>
      )}

      {documentsQuery.isError && (
        <p className="status status-error" role="alert">
          {documentsQuery.error instanceof ApiError
            ? documentsQuery.error.message
            : 'Ocurrió un error inesperado al cargar los documentos.'}
        </p>
      )}

      {documentsQuery.isSuccess && (
        <>
          <table className="data-table documents-table">
            <thead>
              <tr>
                <th>Archivo</th>
                <th>Total items</th>
                <th>Estado</th>
                <th>Fecha</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {documentsQuery.data.items.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-row">
                    Todavía no se ha subido ningún documento.
                  </td>
                </tr>
              )}
              {documentsQuery.data.items.map((document) => (
                <DocumentRow key={document.id} document={document} />
              ))}
            </tbody>
          </table>
          <PaginationControls
            page={documentsQuery.data.page}
            totalPages={documentsQuery.data.totalPages}
            onChange={setDocumentsPage}
          />
        </>
      )}
    </section>
  );
}
