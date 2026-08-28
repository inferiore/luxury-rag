import { AskView } from './components/AskView';
import { DocumentsView } from './components/DocumentsView';
import { UploadView } from './components/UploadView';

function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>RAG — Catálogo de tours</h1>
        <p>Herramienta interna: subir el catálogo y hacer preguntas sobre él.</p>
      </header>

      <main className="app-main">
        <UploadView />
        <DocumentsView />
        <AskView />
      </main>
    </div>
  );
}

export default App;
