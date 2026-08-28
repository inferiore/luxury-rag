import * as fs from 'fs';
import * as path from 'path';

/**
 * Eval harness de alucinaciones — spec 10-eval-harness-hallucinaciones.md.
 *
 * Script standalone: NO importa nada de `rag/src/` (no arranca Nest, no
 * conoce la config de la app) — es un cliente HTTP externo que hace
 * peticiones reales a `POST /query` (spec 04-query-endpoint.md,
 * `Implementado`) y compara la respuesta contra un dataset dorado.
 *
 * Uso: `npm run eval` (o `ts-node -r tsconfig-paths/register
 * scripts/run-eval.ts` directo).
 */

interface GoldenQA {
  id: string;
  question: string;
  topK?: number;
  expectedMatched: boolean;
  mustContain: string[];
  mustNotContain?: string[];
  notes?: string;
}

interface QueryResponse {
  answer: string;
  matched: boolean;
}

interface EvalResult {
  id: string;
  question: string;
  topK: number | null;
  expectedMatched: boolean;
  actualMatched: boolean | null;
  answer: string | null;
  mustContain: string[];
  mustContainMissing: string[];
  mustNotContain: string[];
  mustNotContainFound: string[];
  pass: boolean;
  error: string | null;
}

interface EvalReport {
  runAt: string;
  apiBaseUrl: string;
  summary: { total: number; pass: number; fail: number };
  results: EvalResult[];
}

const EVAL_API_BASE_URL = process.env.EVAL_API_BASE_URL ?? 'http://localhost:3000';
// Mayor que CHAT_TIMEOUT_MS (120_000) del backend (ollama.provider.ts): si
// algo falla, queremos que sea el backend quien reporte el error primero
// (HTTP 5xx / cierre de conexión), no una carrera de timeouts donde el
// cliente del harness corta antes y enmascara el error real.
const EVAL_REQUEST_TIMEOUT_MS = 150_000;

const DATASET_PATH = path.join(__dirname, '..', 'eval', 'golden-qa.json');
const REPORTS_DIR = path.join(__dirname, '..', 'eval', 'reports');

function loadDataset(): GoldenQA[] {
  const raw = fs.readFileSync(DATASET_PATH, 'utf-8');
  return JSON.parse(raw) as GoldenQA[];
}

async function callQuery(
  entry: GoldenQA,
): Promise<{ response?: QueryResponse; error?: string }> {
  const body: { question: string; topK?: number } = {
    question: entry.question,
    ...(entry.topK !== undefined ? { topK: entry.topK } : {}),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EVAL_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${EVAL_API_BASE_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: `No se pudo conectar con ${EVAL_API_BASE_URL}/query: ${message}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    return {
      error: `POST /query respondió ${response.status}: ${text}`,
    };
  }

  try {
    const data = (await response.json()) as QueryResponse;
    return { response: data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `No se pudo parsear la respuesta JSON de /query: ${message}` };
  }
}

function evaluateEntry(
  entry: GoldenQA,
  response: QueryResponse,
): Omit<EvalResult, 'id' | 'question' | 'topK' | 'expectedMatched' | 'error'> {
  const answerLower = response.answer.toLowerCase();

  const mustContain = entry.mustContain ?? [];
  const mustContainMissing = mustContain.filter(
    (s) => !answerLower.includes(s.toLowerCase()),
  );

  const mustNotContain = entry.mustNotContain ?? [];
  const mustNotContainFound = mustNotContain.filter((s) =>
    answerLower.includes(s.toLowerCase()),
  );

  const matchedOk = response.matched === entry.expectedMatched;
  const mustContainOk = mustContainMissing.length === 0;
  const mustNotContainOk = mustNotContainFound.length === 0;

  return {
    actualMatched: response.matched,
    answer: response.answer,
    mustContain,
    mustContainMissing,
    mustNotContain,
    mustNotContainFound,
    pass: matchedOk && mustContainOk && mustNotContainOk,
  };
}

function printResult(result: EvalResult): void {
  if (result.pass) {
    console.log(`[PASS] ${result.id}`);
    return;
  }

  console.log(`[FAIL] ${result.id}`);
  if (result.error) {
    console.log(`  error: ${result.error}`);
    return;
  }
  console.log(
    `  expectedMatched=${result.expectedMatched} actualMatched=${result.actualMatched}`,
  );
  if (result.mustContainMissing.length > 0) {
    console.log(`  mustContain faltante: ${JSON.stringify(result.mustContainMissing)}`);
  }
  if (result.mustNotContainFound.length > 0) {
    console.log(
      `  mustNotContain encontrado (no debía aparecer): ${JSON.stringify(result.mustNotContainFound)}`,
    );
  }
  console.log(`  answer: ${result.answer}`);
}

function saveReport(report: EvalReport): string {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const safeTimestamp = report.runAt.replace(/:/g, '-');
  const filePath = path.join(REPORTS_DIR, `${safeTimestamp}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
  return filePath;
}

async function main(): Promise<void> {
  const dataset = loadDataset();
  const runAt = new Date().toISOString();
  const results: EvalResult[] = [];

  for (const entry of dataset) {
    const { response, error } = await callQuery(entry);

    if (error || !response) {
      const result: EvalResult = {
        id: entry.id,
        question: entry.question,
        topK: entry.topK ?? null,
        expectedMatched: entry.expectedMatched,
        actualMatched: null,
        answer: null,
        mustContain: entry.mustContain ?? [],
        mustContainMissing: entry.mustContain ?? [],
        mustNotContain: entry.mustNotContain ?? [],
        mustNotContainFound: [],
        pass: false,
        error: error ?? 'Error desconocido',
      };
      results.push(result);
      printResult(result);
      continue;
    }

    const evaluated = evaluateEntry(entry, response);
    const result: EvalResult = {
      id: entry.id,
      question: entry.question,
      topK: entry.topK ?? null,
      expectedMatched: entry.expectedMatched,
      error: null,
      ...evaluated,
    };
    results.push(result);
    printResult(result);
  }

  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.length - passCount;

  const report: EvalReport = {
    runAt,
    apiBaseUrl: EVAL_API_BASE_URL,
    summary: { total: results.length, pass: passCount, fail: failCount },
    results,
  };

  const reportPath = saveReport(report);

  console.log('');
  console.log(`Total: ${results.length} | PASS: ${passCount} | FAIL: ${failCount}`);
  console.log(`Reporte guardado en: ${reportPath}`);

  process.exitCode = failCount === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('Error inesperado corriendo el eval harness:', error);
  process.exitCode = 1;
});
