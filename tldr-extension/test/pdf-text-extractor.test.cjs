const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sourcePath = path.resolve(
  __dirname,
  "../src/sidepanel/pdf-text-extractor.ts"
);
const compileDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "tldr-pdf-text-test-")
);
childProcess.execFileSync(
  path.resolve(__dirname, "../node_modules/.bin/tsc"),
  [
    "--ignoreConfig",
    sourcePath,
    "--target",
    "ES2022",
    "--module",
    "Node16",
    "--moduleResolution",
    "Node16",
    "--lib",
    "ES2022,DOM,DOM.Iterable",
    "--skipLibCheck",
    "--outDir",
    compileDirectory,
  ],
  { stdio: "inherit" }
);

const {
  extractPdfText,
  PdfTextExtractionError,
} = require(path.join(compileDirectory, "pdf-text-extractor.js"));

const PDF_VIEWER_ORIGIN =
  "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai";
const originalGlobals = {
  document: global.document,
  fetch: global.fetch,
  setTimeout: global.setTimeout,
  URL: global.URL,
  window: global.window,
};

function pdfBytes(prefixLength = 0) {
  return Buffer.concat([
    Buffer.alloc(prefixLength, 0x20),
    Buffer.from("%PDF-1.7\nmock"),
  ]);
}

function installEnvironment({
  body = pdfBytes(),
  contentLength,
  fetchError,
  responseStatus = 200,
  viewerText = "Extracted PDF text",
  viewerResponds = true,
} = {}) {
  const listeners = new Set();
  const viewerSource = {};
  const state = {
    appended: false,
    blob: null,
    embed: null,
    fetchCalls: [],
    listenerCount: 0,
    removed: false,
    revoked: [],
  };
  const fakeWindow = {
    addEventListener(type, listener) {
      if (type === "message") listeners.add(listener);
      state.listenerCount = listeners.size;
    },
    removeEventListener(type, listener) {
      if (type === "message") listeners.delete(listener);
      state.listenerCount = listeners.size;
    },
  };
  const dispatch = (source, data) => {
    for (const listener of [...listeners]) {
      listener({
        data,
        origin: PDF_VIEWER_ORIGIN,
        source,
      });
    }
  };
  const embed = {
    attributes: {},
    postCalls: [],
    src: "",
    style: {},
    type: "",
    remove() {
      state.removed = true;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    postMessage(message) {
      this.postCalls.push(message);
      if (!viewerResponds) return;
      if (message.type === "selectAll" && !this.sentLoaded) {
        this.sentLoaded = true;
        queueMicrotask(() =>
          dispatch(viewerSource, {
            type: "documentLoaded",
            load_state: "success",
          })
        );
      }
      if (message.type === "getSelectedText") {
        queueMicrotask(() => {
          dispatch({}, {
            type: "getSelectedTextReply",
            selectedText: "spoofed",
          });
          dispatch(viewerSource, {
            type: "getSelectedTextReply",
            selectedText: viewerText,
          });
        });
      }
    },
  };
  const fakeDocument = {
    body: {
      append(node) {
        state.appended = true;
        state.embed = node;
      },
    },
    createElement(tagName) {
      assert.strictEqual(tagName, "embed");
      return embed;
    },
  };
  class FakeURL extends originalGlobals.URL {}
  FakeURL.createObjectURL = (blob) => {
    state.blob = blob;
    return "blob:chrome-extension://test/pdf";
  };
  FakeURL.revokeObjectURL = (url) => {
    state.revoked.push(url);
  };

  global.window = fakeWindow;
  global.document = fakeDocument;
  global.URL = FakeURL;
  global.fetch = async (url, options) => {
    state.fetchCalls.push({ url, options });
    if (fetchError) throw fetchError;
    const headers = {};
    if (contentLength !== undefined) {
      headers["content-length"] = String(contentLength);
    }
    return new Response(body, {
      status: responseStatus,
      headers,
    });
  };

  return state;
}

function restoreEnvironment() {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) {
      delete global[key];
    } else {
      global[key] = value;
    }
  }
}

async function expectCode(promise, code) {
  await assert.rejects(
    promise,
    (error) =>
      error instanceof PdfTextExtractionError &&
      error.code === code &&
      typeof error.message === "string" &&
      error.message.length > 0
  );
}

(async () => {
  try {
    const longText = `${"a".repeat(399_999)}🙂Z`;
    const signal = new AbortController().signal;
    const success = installEnvironment({
      body: pdfBytes(1023),
      viewerText: longText,
    });
    const result = await extractPdfText(
      "https://example.com/report.pdf#page=4:~:text=fact",
      { signal }
    );
    assert.strictEqual(success.fetchCalls.length, 1);
    assert.strictEqual(
      success.fetchCalls[0].url,
      "https://example.com/report.pdf"
    );
    assert.strictEqual(success.fetchCalls[0].options.credentials, "include");
    assert.strictEqual(success.fetchCalls[0].options.signal, signal);
    assert.strictEqual(Array.from(result.text).length, 400_000);
    assert.ok(result.text.endsWith("🙂"));
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(success.blob.type, "application/pdf");
    assert.strictEqual(success.appended, true);
    assert.strictEqual(success.removed, true);
    assert.deepStrictEqual(success.revoked, [
      "blob:chrome-extension://test/pdf",
    ]);
    assert.strictEqual(success.listenerCount, 0);
    console.log(
      "PASS: native PDF extraction strips fragments, binds replies, truncates safely, and cleans up"
    );

    restoreEnvironment();
    installEnvironment({
      contentLength: 50 * 1024 * 1024 + 1,
    });
    await expectCode(
      extractPdfText("https://example.com/large.pdf"),
      "too-large"
    );
    console.log("PASS: declared PDFs above 50 MiB are rejected");

    restoreEnvironment();
    installEnvironment({ body: Buffer.from("<html>not a pdf</html>") });
    await expectCode(
      extractPdfText("https://example.com/not-pdf"),
      "invalid"
    );
    console.log("PASS: non-PDF downloads are rejected by signature");

    restoreEnvironment();
    const empty = installEnvironment({ viewerText: " \n\t " });
    await expectCode(
      extractPdfText("https://example.com/scan.pdf"),
      "empty"
    );
    assert.strictEqual(empty.removed, true);
    assert.strictEqual(empty.listenerCount, 0);
    console.log("PASS: scanned/empty PDFs return a typed, cleaned-up error");

    restoreEnvironment();
    const timedOut = installEnvironment({ viewerResponds: false });
    global.setTimeout = (callback, delay, ...args) =>
      originalGlobals.setTimeout(
        callback,
        delay === 15_000 ? 1 : delay,
        ...args
      );
    await expectCode(
      extractPdfText("https://example.com/stalled.pdf"),
      "timeout"
    );
    assert.strictEqual(timedOut.removed, true);
    assert.strictEqual(timedOut.listenerCount, 0);
    console.log("PASS: stalled native PDF viewers time out and clean up");

    restoreEnvironment();
    const aborted = installEnvironment();
    const controller = new AbortController();
    controller.abort();
    await expectCode(
      extractPdfText("https://example.com/cancelled.pdf", {
        signal: controller.signal,
      }),
      "aborted"
    );
    assert.strictEqual(aborted.fetchCalls.length, 0);
    console.log("PASS: pre-aborted PDF extraction never starts a download");

    restoreEnvironment();
    installEnvironment({ responseStatus: 403 });
    await expectCode(
      extractPdfText("https://example.com/private.pdf"),
      "download"
    );
    console.log("PASS: HTTP failures have a concise typed download error");
  } finally {
    restoreEnvironment();
    fs.rmSync(compileDirectory, { recursive: true, force: true });
  }
})().catch((error) => {
  restoreEnvironment();
  fs.rmSync(compileDirectory, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
