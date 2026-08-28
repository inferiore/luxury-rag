import { create } from 'zustand';
import type { UploadSuccessResponse } from '../api/types';

/**
 * Estado global de UI (inputs de formulario + último resultado de upload
 * confirmado). El estado de red (loading/error/success de las llamadas HTTP)
 * vive en los hooks de React Query de cada componente, no aquí — Zustand solo
 * guarda estado de interacción que tiene sentido compartir entre vistas.
 */
interface AppState {
  selectedFile: File | null;
  setSelectedFile: (file: File | null) => void;

  lastUpload: UploadSuccessResponse | null;
  setLastUpload: (result: UploadSuccessResponse | null) => void;

  question: string;
  setQuestion: (question: string) => void;

  documentsPage: number;
  setDocumentsPage: (page: number) => void;

  expandedDocumentId: string | null;
  setExpandedDocumentId: (id: string | null) => void;

  chunksPage: number;
  setChunksPage: (page: number) => void;
}

export const useAppStore = create<AppState>((set) => ({
  selectedFile: null,
  setSelectedFile: (file) => set({ selectedFile: file }),

  lastUpload: null,
  setLastUpload: (result) => set({ lastUpload: result }),

  question: '',
  setQuestion: (question) => set({ question }),

  documentsPage: 1,
  setDocumentsPage: (page) => set({ documentsPage: page }),

  expandedDocumentId: null,
  // Al cambiar de fila expandida (o al colapsar) se resetea la página de la
  // sub-tabla de chunks, para no arrastrar la paginación de un documento a otro.
  setExpandedDocumentId: (id) =>
    set((state) => ({
      expandedDocumentId: state.expandedDocumentId === id ? null : id,
      chunksPage: 1,
    })),

  chunksPage: 1,
  setChunksPage: (page) => set({ chunksPage: page }),
}));
