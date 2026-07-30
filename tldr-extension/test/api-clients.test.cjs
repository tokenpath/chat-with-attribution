const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const Logic = require("../sidepanel/panel-logic.js");
const extensionRoot = path.resolve(__dirname, "..");
const encoder = new TextEncoder();

function chromeStorage(initial) {
  const values = { ...initial };
  return {
    local: {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          requested
            .filter((key) => typeof key === "string" && key in values)
            .map((key) => [key, values[key]])
        );
      },
      async set(next) {
        Object.assign(values, next);
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          delete values[key];
        }
      },
    },
  };
}

function loadClassicClient(
  filename,
  globalName,
  {
    fetch,
    storage = {},
    setTimeout: contextSetTimeout = setTimeout,
    clearTimeout: contextClearTimeout = clearTimeout,
    warnings = [],
  }
) {
  const context = vm.createContext({
    AbortController,
    DOMException,
    ReadableStream,
    Response,
    TextDecoder,
    TextEncoder,
    TldrPanelLogic: Logic,
    URL,
    chrome: { storage: chromeStorage(storage) },
    clearTimeout: contextClearTimeout,
    console: {
      warn(...args) {
        warnings.push(args.join(" "));
      },
    },
    fetch,
    setTimeout: contextSetTimeout,
  });
  const source = fs.readFileSync(
    path.join(extensionRoot, "sidepanel", filename),
    "utf8"
  );
  vm.runInContext(source, context, { filename });
  return vm.runInContext(globalName, context);
}

function tokenPathWith(fetch, options = {}) {
  return loadClassicClient("tokenpath.js", "TokenPath", {
    fetch,
    storage: {
      // Only allowlisted origins survive TokenPath.getAuth().
      tokenpathBaseUrl: "http://localhost:8000",
      tokenpathKey: "tpk_test",
    },
    ...options,
  });
}

function byteStreamResponse(chunks, contentType = "text/event-stream") {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": contentType } }
  );
}

function textStreamResponse(text) {
  return byteStreamResponse([encoder.encode(text)]);
}

function sseEvent(name, value, newline = "\n") {
  const data = typeof value === "string" ? value : JSON.stringify(value);
  return `event: ${name}${newline}data: ${data}${newline}${newline}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function expectClientError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    if (status !== undefined) assert.equal(error?.status, status);
    return true;
  });
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test("TokenPath sends the key and document only to allowlisted origins", async () => {
  const accepted = [
    ["https://api.tokenpath.ai", "https://api.tokenpath.ai"],
    ["https://api.tokenpath.ai/", "https://api.tokenpath.ai"],
    ["https://api-staging.tokenpath.ai", "https://api-staging.tokenpath.ai"],
    ["http://localhost:8000", "http://localhost:8000"],
    ["http://localhost:8000/", "http://localhost:8000"],
    ["  http://127.0.0.1:8000  ", "http://127.0.0.1:8000"],
  ];
  for (const [stored, expected] of accepted) {
    const warnings = [];
    const client = loadClassicClient("tokenpath.js", "TokenPath", {
      fetch: async () => jsonResponse({ available_tokens: 1 }),
      storage: { tokenpathBaseUrl: stored, tokenpathKey: "tpk_test" },
      warnings,
    });
    assert.equal((await client.getAuth()).baseUrl, expected, stored);
    assert.deepEqual(warnings, [], `${stored} must not warn`);
  }

  const rejected = [
    "https://evil.example",
    "https://api.tokenpath.ai.evil.example",
    "http://api.tokenpath.ai",
    "https://localhost:8000",
    "http://localhost:8001",
    "https://api.tokenpath.ai/v1",
    "https://api.tokenpath.ai/?to=evil.example",
    "https://api.tokenpath.ai#evil",
    "https://user:pass@api.tokenpath.ai",
    "javascript:alert(1)",
    "not a url",
    "",
    null,
    42,
  ];
  for (const stored of rejected) {
    const warnings = [];
    const client = loadClassicClient("tokenpath.js", "TokenPath", {
      fetch: async () => jsonResponse({ available_tokens: 1 }),
      storage: { tokenpathBaseUrl: stored, tokenpathKey: "tpk_test" },
      warnings,
    });
    assert.equal(
      (await client.getAuth()).baseUrl,
      "https://api.tokenpath.ai",
      `${String(stored)} must fall back to production`
    );
    // Only a value that was actually set and refused is worth a warning.
    const expectedWarnings =
      stored === "" || stored === null || stored === undefined ? 0 : 1;
    assert.equal(warnings.length, expectedWarnings, String(stored));
    // The warning is printed once per panel, not once per request.
    await client.getAuth();
    assert.equal(warnings.length, expectedWarnings, String(stored));
  }
});

test("TokenPath requests an allowlisted origin even with a hostile setting", async () => {
  let capturedUrl = null;
  const client = loadClassicClient("tokenpath.js", "TokenPath", {
    fetch: async (url) => {
      capturedUrl = url;
      return jsonResponse({ available_tokens: 9 });
    },
    storage: {
      tokenpathBaseUrl: "https://attacker.example/collect",
      tokenpathKey: "tpk_test",
    },
  });
  assert.equal(await client.fetchCredits(), 9);
  assert.equal(capturedUrl, "https://api.tokenpath.ai/v1/me/credits");
});

test("TokenPath generate parses fragmented SSE and returns canonical done data", async () => {
  const messages = [
    { role: "system", content: "Be concise." },
    { role: "user", content: "Summarize 🎓." },
  ];
  const usage = {
    input_tokens: 11,
    output_tokens: 4,
    billed_tokens: 15,
  };
  const done = {
    answer: "Canonical: Hi 🎓漢字.",
    model: "tokenpath/test-model",
    usage,
    credits_remaining: 12_345,
  };
  const streamText =
    ": generation started\r\n\r\n" +
    sseEvent("delta", { text: "Hi 🎓" }, "\r\n") +
    sseEvent("progress", { phase: "generating" }, "\r\n") +
    sseEvent("delta", { text: "漢字" }, "\r\n") +
    sseEvent("done", done, "\r\n");
  const bytes = encoder.encode(streamText);
  const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
  let capturedRequest = null;
  const client = tokenPathWith(async (url, options) => {
    capturedRequest = { url, options };
    return byteStreamResponse(chunks);
  });
  const accumulated = [];

  const result = await client.generate({
    messages,
    maxOutputTokens: 128,
    onDelta(_delta, answer) {
      accumulated.push(answer);
    },
  });

  assert.equal(capturedRequest.url, "http://localhost:8000/v1/generate");
  assert.equal(capturedRequest.options.method, "POST");
  assert.equal(
    capturedRequest.options.headers.Authorization,
    "Bearer tpk_test"
  );
  assert.equal(capturedRequest.options.headers.Accept, "text/event-stream");
  assert.deepEqual(JSON.parse(capturedRequest.options.body), {
    messages,
    max_output_tokens: 128,
  });
  assert.equal(result.answer, done.answer);
  assert.notEqual(result.answer, accumulated.at(-1));
  assert.equal(result.model, done.model);
  assert.deepEqual(plain(result.usage), usage);
  assert.equal(result.creditsRemaining, done.credits_remaining);
  assert.deepEqual(accumulated, ["Hi 🎓", "Hi 🎓漢字"]);
});

test("TokenPath generate accepts a done event terminated by EOF", async () => {
  const done = {
    answer: "Complete.",
    model: "tokenpath/test-model",
    usage: {
      input_tokens: 2,
      output_tokens: 1,
      billed_tokens: 3,
    },
    credits_remaining: null,
  };
  const streamText =
    sseEvent("delta", { text: "Complete" }) +
    `event: done\ndata: ${JSON.stringify(done)}`;
  const client = tokenPathWith(async () => textStreamResponse(streamText));
  const result = await client.generate({
    messages: [{ role: "user", content: "question" }],
  });
  assert.deepEqual(plain(result), {
    answer: done.answer,
    model: done.model,
    usage: done.usage,
    creditsRemaining: null,
  });
});

test("TokenPath generate rejects malformed and incomplete streams", async () => {
  const malformed = tokenPathWith(async () =>
    textStreamResponse("event: delta\ndata: {not-json}\n\n")
  );
  await expectClientError(
    malformed.generate({
      messages: [{ role: "user", content: "question" }],
    }),
    "invalid_stream",
    200
  );

  const incomplete = tokenPathWith(async () =>
    textStreamResponse(sseEvent("delta", { text: "partial" }))
  );
  await assert.rejects(
    incomplete.generate({
      messages: [{ role: "user", content: "question" }],
    }),
    (error) => {
      assert.equal(error?.code, "incomplete_stream");
      assert.equal(error?.details?.partialAnswer, "partial");
      return true;
    }
  );
});

test("TokenPath generate preserves partial text on a stream error event", async () => {
  const streamText =
    sseEvent("delta", { text: "partial" }) +
    sseEvent("error", {
      error: {
        code: "generation_failed",
        message: "The generation backend failed.",
        request_id: "req_stream_test",
      },
    });
  const client = tokenPathWith(async () => textStreamResponse(streamText));

  await assert.rejects(
    client.generate({
      messages: [{ role: "user", content: "question" }],
    }),
    (error) => {
      assert.equal(error?.status, 200);
      assert.equal(error?.code, "generation_failed");
      assert.equal(error?.message, "The generation backend failed.");
      assert.equal(error?.details?.partialAnswer, "partial");
      assert.equal(error?.details?.requestId, "req_stream_test");
      return true;
    }
  );
});

function stalledSseResponse(signal, firstEvent) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const abort = () =>
          controller.error(new DOMException("Aborted", "AbortError"));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        controller.enqueue(encoder.encode(firstEvent));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

test("TokenPath generate caller abort cancels an active response stream", async () => {
  const external = new AbortController();
  let sawDelta = false;
  const client = tokenPathWith(async (_url, options) =>
    stalledSseResponse(
      options.signal,
      sseEvent("delta", { text: "first" })
    )
  );

  await expectClientError(
    client.generate({
      messages: [{ role: "user", content: "question" }],
      signal: external.signal,
      onDelta() {
        sawDelta = true;
        external.abort();
      },
    }),
    "aborted",
    0
  );
  assert.equal(sawDelta, true);
});

test("TokenPath generate closes the connection when a stream event throws", async () => {
  const failingEvents = [
    ["invalid_stream", "event: delta\ndata: {not-json}\n\n"],
    ["invalid_stream", sseEvent("delta", { text: 7 })],
    [
      "generation_failed",
      sseEvent("error", {
        error: {
          code: "generation_failed",
          message: "The generation backend failed.",
        },
      }),
    ],
  ];

  for (const [code, event] of failingEvents) {
    let aborted = false;
    const client = tokenPathWith(async (_url, options) => {
      options.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true }
      );
      // The server keeps the response open after the offending event, exactly
      // as a real stalled or erroring stream would.
      return stalledSseResponse(options.signal, event);
    });

    await expectClientError(
      client.generate({
        messages: [{ role: "user", content: "question" }],
      }),
      code,
      200
    );
    assert.equal(aborted, true, `${code} must close the HTTP connection`);
  }
});

test("TokenPath generate times out while an active stream is idle", async () => {
  const fastSetTimeout = (callback, delay, ...args) =>
    setTimeout(callback, delay === 90_000 ? 10 : delay, ...args);
  const client = tokenPathWith(
    async (_url, options) =>
      stalledSseResponse(
        options.signal,
        sseEvent("delta", { text: "partial" })
      ),
    { setTimeout: fastSetTimeout }
  );

  await assert.rejects(
    client.generate({
      messages: [{ role: "user", content: "question" }],
    }),
    (error) => {
      assert.equal(error?.status, 0);
      assert.equal(error?.code, "timeout");
      assert.equal(error?.details?.partialAnswer, "partial");
      return true;
    }
  );
});

test("TokenPath generate preserves structured HTTP errors", async () => {
  const client = tokenPathWith(async () =>
    jsonResponse(
      {
        error: {
          code: "insufficient_credits",
          message: "Not enough generation credits.",
          details: { available_tokens: 7 },
          request_id: "req_http_test",
        },
      },
      402
    )
  );

  await assert.rejects(
    client.generate({
      messages: [{ role: "user", content: "question" }],
    }),
    (error) => {
      assert.equal(error?.status, 402);
      assert.equal(error?.code, "insufficient_credits");
      assert.equal(error?.message, "Not enough generation credits.");
      assert.equal(error?.details?.available_tokens, 7);
      assert.equal(error?.details?.requestId, "req_http_test");
      return true;
    }
  );
});

test("TokenPath generate validates terminal done metadata", async () => {
  const validDone = {
    answer: "Answer.",
    model: "tokenpath/test-model",
    usage: {
      input_tokens: 2,
      output_tokens: 1,
      billed_tokens: 3,
    },
    credits_remaining: 100,
  };
  const withoutCredits = { ...validDone };
  delete withoutCredits.credits_remaining;
  const invalidDoneEvents = [
    { ...validDone, answer: "" },
    { ...validDone, model: " " },
    {
      ...validDone,
      usage: { ...validDone.usage, input_tokens: -1 },
    },
    {
      ...validDone,
      usage: { ...validDone.usage, output_tokens: 1.5 },
    },
    { ...validDone, credits_remaining: -1 },
    withoutCredits,
  ];

  for (const done of invalidDoneEvents) {
    const client = tokenPathWith(async () =>
      textStreamResponse(sseEvent("done", done))
    );
    await expectClientError(
      client.generate({
        messages: [{ role: "user", content: "question" }],
      }),
      "invalid_stream",
      200
    );
  }
});

const heatmapInput = {
  document: "x🎓y漢",
  question: "Where?",
  answer: "🙂A🚀",
};
const validHeatmap = {
  row: [0, 1],
  col: [0, 1],
  data: [0.25, 0.75],
  shape: [2, 2],
  answer_offsets: [
    [0, 1],
    [1, 3],
  ],
  document_offsets: [
    [0, 2],
    [2, 4],
  ],
};

test("TokenPath validates COO data and converts both offset tables", async () => {
  const client = tokenPathWith(async () => jsonResponse(validHeatmap));
  const result = await client.heatmap(heatmapInput);

  assert.deepEqual(plain(result), {
    row: [0, 1],
    col: [0, 1],
    data: [0.25, 0.75],
    shape: [2, 2],
    answerOffsets: [
      [0, 2],
      [2, 5],
    ],
    documentOffsets: [
      [0, 3],
      [3, 5],
    ],
  });
});

test("TokenPath rejects malformed sparse heatmaps", async () => {
  const malformed = [
    { ...validHeatmap, shape: [2] },
    { ...validHeatmap, row: [0], col: [0, 1], data: [0.25, 0.75] },
    { ...validHeatmap, row: [0, 2] },
    { ...validHeatmap, col: [0, -1] },
    { ...validHeatmap, data: [0.25, 1.1] },
    { ...validHeatmap, answer_offsets: [[0, 1]] },
    {
      ...validHeatmap,
      document_offsets: [
        [0, 2],
        [2, 5],
      ],
    },
  ];

  for (const body of malformed) {
    const client = tokenPathWith(async () => jsonResponse(body));
    await expectClientError(
      client.heatmap(heatmapInput),
      "invalid_response",
      200
    );
  }
});

function stalledJsonResponse(signal, bodyStarted) {
  return {
    ok: true,
    status: 200,
    async json() {
      bodyStarted();
      return new Promise((resolve, reject) => {
        let fallback = null;
        const abort = () => {
          if (fallback !== null) clearTimeout(fallback);
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        fallback = setTimeout(
          () => reject(new Error("Response body was not cancelled")),
          250
        );
      });
    },
  };
}

test("TokenPath caller abort remains active while JSON is read", async () => {
  const external = new AbortController();
  let bodyStartedResolve;
  const bodyStarted = new Promise((resolve) => {
    bodyStartedResolve = resolve;
  });
  const client = tokenPathWith(async (_url, options) =>
    stalledJsonResponse(options.signal, bodyStartedResolve)
  );

  const pending = client.heatmap({
    ...heatmapInput,
    signal: external.signal,
  });
  await bodyStarted;
  external.abort();
  await expectClientError(pending, "aborted", 0);
});

test("TokenPath timeout remains active while JSON is read", async () => {
  let bodyStartedResolve;
  const bodyStarted = new Promise((resolve) => {
    bodyStartedResolve = resolve;
  });
  const fastSetTimeout = (callback, delay, ...args) =>
    setTimeout(callback, delay === 90_000 ? 10 : delay, ...args);
  const client = tokenPathWith(
    async (_url, options) =>
      stalledJsonResponse(options.signal, bodyStartedResolve),
    { setTimeout: fastSetTimeout }
  );

  const pending = client.heatmap(heatmapInput);
  await bodyStarted;
  await expectClientError(pending, "timeout", 0);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`PASS: ${name}`);
    } catch (error) {
      failures++;
      console.error(`FAIL: ${name}`);
      console.error(error);
    }
  }
  if (failures) {
    process.exitCode = 1;
    throw new Error(`${failures} API client test(s) failed.`);
  }
  console.log("\nAll API client assertions passed.");
})().catch((error) => {
  if (!process.exitCode) process.exitCode = 1;
  console.error(error);
});
