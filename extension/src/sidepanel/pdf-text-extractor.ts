const CHROME_PDF_VIEWER_ORIGIN =
  "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai";

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_CODE_POINTS = 400_000;
const PDF_VIEWER_TIMEOUT_MS = 15_000;
const PDF_SIGNATURE_START_LIMIT = 1024;
const PDF_SIGNATURE_LENGTH = 5;

export type PdfTextExtractionErrorCode =
  | "aborted"
  | "download"
  | "empty"
  | "invalid"
  | "timeout"
  | "too-large"
  | "unavailable";

export class PdfTextExtractionError extends Error {
  readonly code: PdfTextExtractionErrorCode;

  constructor(
    code: PdfTextExtractionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PdfTextExtractionError";
    this.code = code;
  }
}

export interface PdfTextExtractionResult {
  text: string;
  truncated: boolean;
}

export interface PdfTextExtractionOptions {
  signal?: AbortSignal;
}

interface ExtractionWaiter {
  resolve: () => void;
  reject: (error: PdfTextExtractionError) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface ChromePdfEmbedElement extends HTMLEmbedElement {
  postMessage(message: unknown): void;
}

type PdfByteChunk = Uint8Array<ArrayBuffer>;

let extractionLocked = false;
const extractionWaiters: ExtractionWaiter[] = [];

/**
 * Downloads a PDF and asks a hidden copy of Chrome's native PDF viewer for
 * the same PDFium text that powers selection in the visible viewer.
 *
 * Calls are serialized because the native viewer's scripting replies do not
 * carry a caller-provided correlation ID.
 */
export async function extractPdfText(
  url: string,
  options: PdfTextExtractionOptions = {}
): Promise<PdfTextExtractionResult> {
  const { signal } = options;
  await acquireExtractionLock(signal);
  try {
    throwIfAborted(signal);
    const sourceUrl = pdfUrlWithoutFragment(url);
    const pdfBlob = await downloadPdf(sourceUrl, signal);
    throwIfAborted(signal);
    const selectedText = await extractWithNativePdfViewer(pdfBlob, signal);
    if (!selectedText.trim()) {
      throw new PdfTextExtractionError(
        "empty",
        "This PDF has no searchable text. It may be scanned or image-only."
      );
    }
    return truncateCodePoints(selectedText, MAX_TEXT_CODE_POINTS);
  } finally {
    releaseExtractionLock();
  }
}

function pdfUrlWithoutFragment(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    return parsed.href;
  } catch (error) {
    throw new PdfTextExtractionError(
      "download",
      "Couldn't download this PDF because its address is invalid.",
      { cause: error }
    );
  }
}

async function downloadPdf(
  sourceUrl: string,
  signal?: AbortSignal
): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      credentials: "include",
      signal,
    });
  } catch (error) {
    throw normalizeDownloadError(error, signal);
  }

  if (!response.ok) {
    throw new PdfTextExtractionError(
      "download",
      `Couldn't download this PDF (HTTP ${response.status}).`
    );
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const byteLength = Number(declaredLength);
    if (Number.isFinite(byteLength) && byteLength > MAX_PDF_BYTES) {
      throw pdfTooLargeError();
    }
  }

  try {
    const chunks = response.body
      ? await readPdfStream(response.body, signal)
      : [new Uint8Array(await response.arrayBuffer())];
    throwIfAborted(signal);

    const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (byteLength > MAX_PDF_BYTES) throw pdfTooLargeError();
    if (!hasPdfSignature(chunks)) {
      throw new PdfTextExtractionError(
        "invalid",
        "The downloaded file isn't a valid PDF."
      );
    }
    return new Blob(
      chunks.map((chunk) => chunk.buffer),
      { type: "application/pdf" }
    );
  } catch (error) {
    if (error instanceof PdfTextExtractionError) throw error;
    throw normalizeDownloadError(error, signal);
  }
}

async function readPdfStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<PdfByteChunk[]> {
  const reader = stream.getReader();
  const chunks: PdfByteChunk[] = [];
  let byteLength = 0;
  let signaturePrefix = new Uint8Array(0);
  let signatureChecked = false;

  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      if (!value?.byteLength) continue;

      if (byteLength + value.byteLength > MAX_PDF_BYTES) {
        await reader
          .cancel("PDF exceeds extraction size limit")
          .catch(() => undefined);
        throw pdfTooLargeError();
      }
      const chunk = new Uint8Array(value.byteLength);
      chunk.set(value);
      byteLength += chunk.byteLength;
      chunks.push(chunk);

      if (!signatureChecked) {
        signaturePrefix = appendSignaturePrefix(signaturePrefix, chunk);
        if (
          signaturePrefix.byteLength >=
          PDF_SIGNATURE_START_LIMIT + PDF_SIGNATURE_LENGTH - 1
        ) {
          signatureChecked = true;
          if (!hasPdfSignatureInPrefix(signaturePrefix)) {
            await reader.cancel("Invalid PDF signature").catch(() => undefined);
            throw new PdfTextExtractionError(
              "invalid",
              "The downloaded file isn't a valid PDF."
            );
          }
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  return chunks;
}

function appendSignaturePrefix(
  existing: PdfByteChunk,
  chunk: Uint8Array
): PdfByteChunk {
  const maximum = PDF_SIGNATURE_START_LIMIT + PDF_SIGNATURE_LENGTH - 1;
  if (existing.byteLength >= maximum) return existing;
  const take = Math.min(chunk.byteLength, maximum - existing.byteLength);
  const combined = new Uint8Array(existing.byteLength + take);
  combined.set(existing);
  combined.set(chunk.subarray(0, take), existing.byteLength);
  return combined;
}

function hasPdfSignature(chunks: PdfByteChunk[]): boolean {
  let prefix = new Uint8Array(0);
  for (const chunk of chunks) {
    prefix = appendSignaturePrefix(prefix, chunk);
    if (
      prefix.byteLength >=
      PDF_SIGNATURE_START_LIMIT + PDF_SIGNATURE_LENGTH - 1
    ) {
      break;
    }
  }
  return hasPdfSignatureInPrefix(prefix);
}

function hasPdfSignatureInPrefix(prefix: Uint8Array): boolean {
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
  const lastStart = Math.min(
    PDF_SIGNATURE_START_LIMIT - 1,
    prefix.byteLength - signature.length
  );
  for (let start = 0; start <= lastStart; start++) {
    if (
      signature.every(
        (expected, offset) => prefix[start + offset] === expected
      )
    ) {
      return true;
    }
  }
  return false;
}

async function extractWithNativePdfViewer(
  pdfBlob: Blob,
  signal?: AbortSignal
): Promise<string> {
  if (!document.body) {
    throw new PdfTextExtractionError(
      "unavailable",
      "Chrome's PDF text extractor isn't available on this page."
    );
  }

  const objectUrl = URL.createObjectURL(pdfBlob);
  const embed = document.createElement("embed") as ChromePdfEmbedElement;
  embed.type = "application/pdf";
  embed.src = objectUrl;
  embed.setAttribute("aria-hidden", "true");
  embed.setAttribute("tabindex", "-1");
  Object.assign(embed.style, {
    border: "0",
    height: "800px",
    left: "-10000px",
    opacity: "0",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    width: "800px",
    zIndex: "-2147483648",
  });

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let requestId: ReturnType<typeof setTimeout> | null = null;
  let viewerSource: MessageEventSource | null = null;

  const cleanup = () => {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (requestId !== null) clearTimeout(requestId);
    signal?.removeEventListener("abort", onAbort);
    window.removeEventListener("message", onMessage);
    embed.remove();
    URL.revokeObjectURL(objectUrl);
  };

  let resolveText: (text: string) => void;
  let rejectText: (error: PdfTextExtractionError) => void;
  let settled = false;
  const result = new Promise<string>((resolve, reject) => {
    resolveText = resolve;
    rejectText = reject;
  });

  const finish = (text: string) => {
    if (settled) return;
    settled = true;
    resolveText(text);
  };
  const fail = (error: PdfTextExtractionError) => {
    if (settled) return;
    settled = true;
    rejectText(error);
  };
  const requestSelectedText = () => {
    if (requestId !== null || settled) return;
    requestId = setTimeout(() => {
      requestId = null;
      try {
        embed.postMessage({ type: "getSelectedText" });
      } catch (error) {
        fail(
          new PdfTextExtractionError(
            "unavailable",
            "Chrome couldn't read text from this PDF.",
            { cause: error }
          )
        );
      }
    }, 0);
  };
  function onAbort() {
    fail(abortedError());
  }
  function onMessage(event: MessageEvent<unknown>) {
    if (event.origin !== CHROME_PDF_VIEWER_ORIGIN || !event.source) return;
    if (!isRecord(event.data) || typeof event.data.type !== "string") return;

    if (event.data.type === "documentLoaded") {
      if (viewerSource !== null && event.source !== viewerSource) return;
      if (event.data.load_state !== "success") {
        fail(
          new PdfTextExtractionError(
            "invalid",
            "Chrome couldn't open this PDF."
          )
        );
        return;
      }
      viewerSource = event.source;
      try {
        embed.postMessage({ type: "selectAll" });
        requestSelectedText();
      } catch (error) {
        fail(
          new PdfTextExtractionError(
            "unavailable",
            "Chrome couldn't read text from this PDF.",
            { cause: error }
          )
        );
      }
      return;
    }

    if (
      event.data.type === "getSelectedTextReply" &&
      viewerSource !== null &&
      event.source === viewerSource &&
      typeof event.data.selectedText === "string"
    ) {
      finish(event.data.selectedText);
    }
  }

  try {
    throwIfAborted(signal);
    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });
    timeoutId = setTimeout(() => {
      fail(
        new PdfTextExtractionError(
          "timeout",
          "Chrome took too long to read this PDF. Try again."
        )
      );
    }, PDF_VIEWER_TIMEOUT_MS);
    document.body.append(embed);

    // This first message establishes the viewer's scripting parent. If the PDF
    // is already loaded, Chrome immediately answers with `documentLoaded`; if
    // not, Chrome queues the request until loading finishes.
    embed.postMessage({ type: "selectAll" });
    return await result;
  } catch (error) {
    if (error instanceof PdfTextExtractionError) throw error;
    if (signal?.aborted) throw abortedError();
    throw new PdfTextExtractionError(
      "unavailable",
      "Chrome couldn't read text from this PDF.",
      { cause: error }
    );
  } finally {
    cleanup();
  }
}

function truncateCodePoints(
  text: string,
  maximum: number
): PdfTextExtractionResult {
  let count = 0;
  let utf16End = 0;
  for (const codePoint of text) {
    if (count === maximum) {
      return {
        text: text.slice(0, utf16End),
        truncated: true,
      };
    }
    count++;
    utf16End += codePoint.length;
  }
  return { text, truncated: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDownloadError(
  error: unknown,
  signal?: AbortSignal
): PdfTextExtractionError {
  if (signal?.aborted || isAbortError(error)) return abortedError();
  return new PdfTextExtractionError(
    "download",
    "Couldn't download this PDF. It may require access that Chrome didn't share with the extension.",
    { cause: error }
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : isRecord(error) && error.name === "AbortError"
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError();
}

function abortedError(): PdfTextExtractionError {
  return new PdfTextExtractionError(
    "aborted",
    "PDF text extraction was cancelled."
  );
}

function pdfTooLargeError(): PdfTextExtractionError {
  return new PdfTextExtractionError(
    "too-large",
    "This PDF is larger than the 50 MiB extraction limit."
  );
}

function acquireExtractionLock(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!extractionLocked) {
    extractionLocked = true;
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const waiter: ExtractionWaiter = { resolve, reject, signal };
    if (signal) {
      waiter.onAbort = () => {
        const index = extractionWaiters.indexOf(waiter);
        if (index >= 0) extractionWaiters.splice(index, 1);
        reject(abortedError());
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    extractionWaiters.push(waiter);
  });
}

function releaseExtractionLock(): void {
  while (extractionWaiters.length) {
    const waiter = extractionWaiters.shift()!;
    if (waiter.onAbort) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
    }
    if (waiter.signal?.aborted) {
      waiter.reject(abortedError());
      continue;
    }
    waiter.resolve();
    return;
  }
  extractionLocked = false;
}
