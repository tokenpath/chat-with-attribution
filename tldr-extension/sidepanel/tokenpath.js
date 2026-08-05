// TokenPath generation and attribution client for the side panel.
//
// The panel page calls the TokenPath platform directly — with the
// host_permissions in manifest.json, MV3 extension-page fetches are not
// subject to CORS. The key lives in chrome.storage.local. To point at staging
// or a local backend, set
// tokenpathBaseUrl in storage from the service worker / panel console:
//   chrome.storage.local.set({ tokenpathBaseUrl: "http://localhost:8000" })

const TOKENPATH_DEFAULT_BASE_URL = "https://api.tokenpath.ai";
const TOKENPATH_PLATFORM_URL = "https://platform.tokenpath.ai";
const TOKENPATH_MAX_DOCUMENT_CHARS = 400_000;
// Identifies the request as this extension's. It is what routes spend to the
// Browse subscription's monthly allowance, with the account's prepaid credits
// as the fallback; the same request without the header spends credits.
const TOKENPATH_CLIENT_HEADER = "X-TokenPath-Client";
const TOKENPATH_CLIENT_ID = "browse-extension";
const TOKENPATH_SUBSCRIPTION_STATUSES = ["none", "active", "canceling"];
// The shipped plan, used when a response omits either fixed field and when the
// subscription endpoint is not deployed yet.
const TOKENPATH_SUBSCRIPTION_GRANT_TOKENS = 10_000_000;
const TOKENPATH_SUBSCRIPTION_PRICE_USD_CENTS = 700;
// Every request carries the API key and the complete captured page text, so
// the destination is not a free-form preference. Only these exact origins may
// ever receive them; anything else falls back to production.
const TOKENPATH_ALLOWED_BASE_URLS = [
  TOKENPATH_DEFAULT_BASE_URL,
  "https://api-staging.tokenpath.ai",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

class TokenPathError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = "TokenPathError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const TokenPath = {
  Error: TokenPathError,
  PLATFORM_URL: TOKENPATH_PLATFORM_URL,
  MAX_DOCUMENT_CHARS: TOKENPATH_MAX_DOCUMENT_CHARS,

  async getAuth() {
    const stored = await chrome.storage.local.get([
      "tokenpathKey",
      "tokenpathBaseUrl",
    ]);
    return {
      key: stored.tokenpathKey || null,
      baseUrl: allowedBaseUrl(stored.tokenpathBaseUrl),
    };
  },

  async setKey(key) {
    await chrome.storage.local.set({ tokenpathKey: key });
  },

  async clearKey() {
    await chrome.storage.local.remove("tokenpathKey");
  },

  // GET /v1/me/credits — also serves as key validation on connect.
  async fetchCredits() {
    const body = await this._request("GET", "/v1/me/credits");
    return body.available_tokens;
  },

  // GET /v1/subscription — the Browse subscription's state and what is left of
  // this month's token allowance.
  //
  // The endpoint is newer than this client, so a 404 is not a failure: it means
  // this account has nothing to report, and it resolves silently to the same
  // shape a `status: "none"` body produces. Every other status follows the
  // ordinary error mapping, so a rejected key still reaches the auth path.
  async fetchSubscription() {
    let body;
    try {
      body = await this._request("GET", "/v1/subscription");
    } catch (error) {
      if (error instanceof TokenPathError && error.status === 404) {
        return unsubscribedPlan();
      }
      throw error;
    }
    return normalizeSubscription(body);
  },

  // POST /v1/generate — stream an answer from TokenPath's server-selected
  // generation model. The caller owns the complete messages-only prompt.
  //
  // `delta` events are for responsive rendering only. The terminal `done`
  // event owns the canonical answer and metadata returned to the caller.
  /**
   * @param {{
   *   messages?: unknown,
   *   maxOutputTokens?: number,
   *   onDelta?: (delta: string, partialAnswer: string) => void,
   *   signal?: AbortSignal,
   * }} [options]
   */
  async generate({
    messages,
    maxOutputTokens,
    onDelta,
    signal: externalSignal,
  } = {}) {
    const normalizedMessages = normalizeGenerationMessages(messages);
    if (onDelta !== undefined && typeof onDelta !== "function") {
      throw new TokenPathError(
        0,
        "invalid_request",
        "TokenPath onDelta must be a function."
      );
    }

    const payload = { messages: normalizedMessages };
    if (maxOutputTokens !== undefined && maxOutputTokens !== null) {
      if (
        !Number.isInteger(maxOutputTokens) ||
        maxOutputTokens < 16 ||
        maxOutputTokens > 2048
      ) {
        throw new TokenPathError(
          0,
          "invalid_request",
          "TokenPath maxOutputTokens must be an integer from 16 to 2048."
        );
      }
      payload.max_output_tokens = maxOutputTokens;
    }

    const { key, baseUrl } = await this.getAuth();
    if (!key) {
      throw new TokenPathError(
        401,
        "not_connected",
        "Not connected to TokenPath."
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    let idleTimer = null;
    const resetIdleTimer = () => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 90_000);
    };
    const abortFromCaller = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abortFromCaller();
      else {
        externalSignal.addEventListener("abort", abortFromCaller, {
          once: true,
        });
      }
    }

    let response;
    let partialAnswer = "";
    try {
      resetIdleTimer();
      response = await fetch(
        baseUrl.replace(/\/$/, "") + "/v1/generate",
        {
          method: "POST",
          headers: {
            Accept: "text/event-stream",
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
            [TOKENPATH_CLIENT_HEADER]: TOKENPATH_CLIENT_ID,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }
      );
      resetIdleTimer();

      if (!response.ok) {
        let body = null;
        try {
          body = await response.json();
        } catch (error) {
          if (controller.signal.aborted || error?.name === "AbortError") {
            throw error;
          }
        }
        throw errorFromTokenPathPayload(body, response.status);
      }

      const contentType = response.headers.get("content-type") || "";
      if (!/text\/event-stream/i.test(contentType)) {
        throw new TokenPathError(
          response.status,
          "invalid_response",
          "TokenPath returned a non-streaming generation response."
        );
      }
      if (!response.body) {
        throw new TokenPathError(
          response.status,
          "invalid_response",
          "TokenPath returned an empty generation stream."
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result = null;

      const consumeEvent = (eventText) => {
        const event = parseSseEvent(eventText);
        if (!event) return;

        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          throw new TokenPathError(
            response.status,
            "invalid_stream",
            "TokenPath returned malformed generation JSON.",
            { event: event.data, partialAnswer }
          );
        }

        if (event.name === "delta") {
          if (
            !data ||
            typeof data !== "object" ||
            typeof data.text !== "string"
          ) {
            throw invalidGenerationEvent(
              response.status,
              "TokenPath returned an invalid generation delta.",
              partialAnswer
            );
          }
          if (!data.text) return;
          partialAnswer += data.text;
          onDelta?.(data.text, partialAnswer);
          return;
        }

        if (event.name === "done") {
          result = normalizeGenerationDone(
            data,
            response.status,
            partialAnswer
          );
          return;
        }

        if (event.name === "error") {
          throw generationStreamError(data, response.status, partialAnswer);
        }
        // SSE permits extension events. Ignore names outside this endpoint's
        // contract so a future informational frame does not break generation.
      };

      while (!result) {
        const { value, done } = await reader.read();
        if (done) break;
        resetIdleTimer();
        buffer += decoder.decode(value, { stream: true });

        let boundary;
        while ((boundary = findSseBoundary(buffer))) {
          const eventText = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          consumeEvent(eventText);
          if (result) {
            await reader.cancel().catch(() => {});
            break;
          }
        }
      }

      buffer += decoder.decode();
      if (!result && buffer.trim()) consumeEvent(buffer);
      if (!result) {
        throw new TokenPathError(
          response.status,
          "incomplete_stream",
          "TokenPath's generation stream ended before its done event.",
          { partialAnswer }
        );
      }
      return result;
    } catch (error) {
      if (error instanceof TokenPathError) throw error;
      const aborted =
        controller.signal.aborted || error?.name === "AbortError";
      if (aborted) {
        throw new TokenPathError(
          0,
          timedOut ? "timeout" : "aborted",
          timedOut
            ? "TokenPath stopped sending generation data."
            : "TokenPath generation was cancelled.",
          { partialAnswer: partialAnswer || null }
        );
      }
      throw new TokenPathError(
        0,
        "network_error",
        "Couldn't reach TokenPath — check your connection.",
        error
      );
    } finally {
      if (idleTimer !== null) clearTimeout(idleTimer);
      externalSignal?.removeEventListener("abort", abortFromCaller);
      // A thrown stream event (malformed JSON, an `error` frame, invalid done
      // metadata) leaves the response body unread and the HTTP connection
      // open. Nothing consumes this stream once generate has settled, so close
      // it here; aborting a completed request is a no-op.
      if (!controller.signal.aborted) controller.abort();
    }
  },

  // POST /v1/attributions/heatmap — attribute an already-generated answer.
  //
  // TokenPath returns sparse COO arrays and token offset tables in Unicode
  // code-point coordinates. Validate the matrix before it reaches UI code and
  // adapt both offset tables to JavaScript's UTF-16 string coordinates.
  /**
   * @param {{
   *   document?: string,
   *   question?: string,
   *   answer?: string,
   *   threshold?: number,
   *   signal?: AbortSignal,
   * }} [options]
   */
  async heatmap({ document, question, answer, threshold, signal } = {}) {
    if (
      typeof document !== "string" ||
      document.length === 0 ||
      typeof question !== "string" ||
      question.length === 0 ||
      typeof answer !== "string" ||
      answer.length === 0
    ) {
      throw new TokenPathError(
        0,
        "invalid_request",
        "TokenPath heatmap requires a non-empty document, question, and answer."
      );
    }

    const payload = { document, question, answer };
    if (threshold !== undefined) {
      if (
        typeof threshold !== "number" ||
        !Number.isFinite(threshold) ||
        threshold < 0 ||
        threshold > 1
      ) {
        throw new TokenPathError(
          0,
          "invalid_request",
          "TokenPath heatmap threshold must be a finite number from 0 to 1."
        );
      }
      payload.threshold = threshold;
    }

    const body = await this._request(
      "POST",
      "/v1/attributions/heatmap",
      payload,
      signal
    );
    const answerOffsetMap = TldrPanelLogic.codePointToUtf16Map(answer);
    const sourceOffsetMap = TldrPanelLogic.codePointToUtf16Map(document);

    const shape = normalizeHeatmapShape(body.shape);
    const [answerTokenCount, documentTokenCount] = shape;
    const row = normalizeHeatmapIndices(
      body.row,
      "row",
      answerTokenCount
    );
    const col = normalizeHeatmapIndices(
      body.col,
      "col",
      documentTokenCount
    );
    const data = normalizeHeatmapScores(body.data);
    if (row.length !== col.length || row.length !== data.length) {
      throw invalidHeatmapResponse(
        "TokenPath heatmap row, col, and data arrays must have equal lengths."
      );
    }

    return {
      row,
      col,
      data,
      shape,
      answerOffsets: normalizeHeatmapOffsets(
        body.answer_offsets,
        "answer_offsets",
        answerTokenCount,
        answerOffsetMap
      ),
      documentOffsets: normalizeHeatmapOffsets(
        body.document_offsets,
        "document_offsets",
        documentTokenCount,
        sourceOffsetMap
      ),
    };
  },

  async _request(method, path, payload, externalSignal) {
    const { key, baseUrl } = await this.getAuth();
    if (!key) {
      throw new TokenPathError(401, "not_connected", "Not connected to TokenPath.");
    }

    // Attribution on a big selection can take a while; fail clearly rather
    // than hanging forever.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 90_000);
    const abortFromCaller = () => controller.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abortFromCaller();
      else {
        externalSignal.addEventListener("abort", abortFromCaller, {
          once: true,
        });
      }
    }
    let res;
    let body = null;
    try {
      res = await fetch(baseUrl.replace(/\/$/, "") + path, {
        method,
        headers: {
          Authorization: "Bearer " + key,
          [TOKENPATH_CLIENT_HEADER]: TOKENPATH_CLIENT_ID,
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });
      try {
        body = await res.json();
      } catch (error) {
        // Invalid JSON is handled below as an empty response, but cancellation
        // while the body is still arriving must retain its timeout/abort
        // semantics. Keeping this read inside the outer try also keeps the
        // controller alive until the complete response has been consumed.
        if (controller.signal.aborted || error?.name === "AbortError") {
          throw error;
        }
      }
    } catch (e) {
      const aborted = controller.signal.aborted || e?.name === "AbortError";
      throw new TokenPathError(
        0,
        aborted
          ? timedOut
            ? "timeout"
            : "aborted"
          : "network_error",
        aborted
          ? timedOut
            ? "TokenPath took too long to respond."
            : "TokenPath attribution was cancelled."
          : "Couldn't reach TokenPath — check your connection."
      );
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    }

    if (!res.ok) {
      throw errorFromTokenPathPayload(body, res.status);
    }
    return body || {};
  },
};

let warnedAboutBaseUrl = false;

// A stored base URL is a developer convenience, never a routing instruction.
// Accept only an exact allowlisted origin, ignoring a trailing slash, and
// reject anything carrying a path, query, fragment, or userinfo.
function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  const origin = `${parsed.protocol}//${parsed.host}`;
  return TOKENPATH_ALLOWED_BASE_URLS.includes(origin) ? origin : null;
}

function allowedBaseUrl(value) {
  if (value === undefined || value === null || value === "") {
    return TOKENPATH_DEFAULT_BASE_URL;
  }
  const normalized = normalizeBaseUrl(value);
  if (normalized) return normalized;
  if (!warnedAboutBaseUrl) {
    warnedAboutBaseUrl = true;
    console.warn(
      "[TokenPath] Ignoring an unsupported tokenpathBaseUrl; using " +
        TOKENPATH_DEFAULT_BASE_URL +
        "."
    );
  }
  return TOKENPATH_DEFAULT_BASE_URL;
}

function normalizeGenerationMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TokenPathError(
      0,
      "invalid_request",
      "TokenPath generation requires at least one chat message."
    );
  }
  const normalized = messages.map((message) => {
    if (
      !message ||
      typeof message !== "object" ||
      !["system", "user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      message.content.length === 0
    ) {
      throw new TokenPathError(
        0,
        "invalid_request",
        "Every TokenPath generation message needs a supported role and text content."
      );
    }
    return { role: message.role, content: message.content };
  });
  if (normalized.at(-1).role !== "user") {
    throw new TokenPathError(
      0,
      "invalid_request",
      "The last TokenPath generation message must have role user."
    );
  }
  return normalized;
}

function findSseBoundary(buffer) {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseSseEvent(eventText) {
  let name = "message";
  const data = [];
  for (const line of eventText.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") name = value || "message";
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  const encoded = data.join("\n").trim();
  return encoded ? { name, data: encoded } : null;
}

function invalidGenerationEvent(status, message, partialAnswer) {
  return new TokenPathError(status, "invalid_stream", message, {
    partialAnswer: partialAnswer || null,
  });
}

function normalizeGenerationDone(data, status, partialAnswer) {
  if (!data || typeof data !== "object") {
    throw invalidGenerationEvent(
      status,
      "TokenPath returned an invalid generation done event.",
      partialAnswer
    );
  }
  if (typeof data.answer !== "string" || !data.answer.trim()) {
    throw invalidGenerationEvent(
      status,
      "TokenPath returned an invalid canonical answer.",
      partialAnswer
    );
  }
  if (typeof data.model !== "string" || !data.model.trim()) {
    throw invalidGenerationEvent(
      status,
      "TokenPath returned an invalid generation model.",
      partialAnswer
    );
  }

  const usage = data.usage;
  const usageFields = ["input_tokens", "output_tokens", "billed_tokens"];
  if (
    !usage ||
    typeof usage !== "object" ||
    !usageFields.every(
      (field) => Number.isInteger(usage[field]) && usage[field] >= 0
    )
  ) {
    throw invalidGenerationEvent(
      status,
      "TokenPath returned invalid generation usage.",
      partialAnswer
    );
  }

  const creditsRemaining = data.credits_remaining;
  if (
    creditsRemaining !== null &&
    (!Number.isInteger(creditsRemaining) || creditsRemaining < 0)
  ) {
    throw invalidGenerationEvent(
      status,
      "TokenPath returned an invalid credit balance.",
      partialAnswer
    );
  }

  return {
    answer: data.answer,
    model: data.model,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      billed_tokens: usage.billed_tokens,
    },
    creditsRemaining,
  };
}

function generationStreamError(data, status, partialAnswer) {
  const error = data?.error;
  if (
    !error ||
    typeof error !== "object" ||
    typeof error.code !== "string" ||
    !error.code ||
    typeof error.message !== "string" ||
    !error.message
  ) {
    return invalidGenerationEvent(
      status,
      "TokenPath returned an invalid generation error event.",
      partialAnswer
    );
  }
  return new TokenPathError(status, error.code, error.message, {
    ...(error.details && typeof error.details === "object"
      ? error.details
      : {}),
    partialAnswer: partialAnswer || null,
    requestId:
      typeof error.request_id === "string" && error.request_id
        ? error.request_id
        : null,
  });
}

function errorFromTokenPathPayload(body, status) {
  const error =
    body?.error && typeof body.error === "object" ? body.error : {};
  const details =
    error.details && typeof error.details === "object"
      ? { ...error.details }
      : {};
  if (typeof error.request_id === "string" && error.request_id) {
    details.requestId = error.request_id;
  }
  return new TokenPathError(
    status,
    typeof error.code === "string" && error.code
      ? error.code
      : "http_" + status,
    typeof error.message === "string" && error.message
      ? error.message
      : "TokenPath request failed (" + status + ").",
    Object.keys(details).length > 0 ? details : null
  );
}

function invalidSubscriptionResponse(message) {
  return new TokenPathError(200, "invalid_response", message);
}

/** What an account with no Browse subscription looks like. */
function unsubscribedPlan() {
  return {
    status: "none",
    renewsAt: null,
    allowanceTokens: 0,
    grantTokens: TOKENPATH_SUBSCRIPTION_GRANT_TOKENS,
    priceUsdCents: TOKENPATH_SUBSCRIPTION_PRICE_USD_CENTS,
  };
}

function normalizeSubscription(body) {
  const status = body?.status;
  if (!TOKENPATH_SUBSCRIPTION_STATUSES.includes(status)) {
    throw invalidSubscriptionResponse(
      "TokenPath returned an unsupported subscription status."
    );
  }

  const renewsAt = body.renews_at;
  const hasRenewal = typeof renewsAt === "string" && renewsAt.trim() !== "";
  if (!hasRenewal && renewsAt !== null && renewsAt !== undefined) {
    throw invalidSubscriptionResponse(
      "TokenPath returned an invalid subscription renewal date."
    );
  }

  return {
    status,
    renewsAt: hasRenewal ? renewsAt : null,
    allowanceTokens: subscriptionCount(body.allowance_tokens, "allowance", 0),
    grantTokens: subscriptionCount(
      body.grant_tokens,
      "grant",
      TOKENPATH_SUBSCRIPTION_GRANT_TOKENS
    ),
    priceUsdCents: subscriptionCount(
      body.price_usd_cents,
      "price",
      TOKENPATH_SUBSCRIPTION_PRICE_USD_CENTS
    ),
  };
}

// Only the allowance moves as tokens are spent; the grant and the price are
// properties of the plan. An omitted count is read as the shipped plan so a
// leaner future response still works, but a present one has to be a real count.
function subscriptionCount(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    throw invalidSubscriptionResponse(
      `TokenPath returned an invalid subscription ${field}.`
    );
  }
  return value;
}

function invalidHeatmapResponse(message) {
  return new TokenPathError(200, "invalid_response", message);
}

function normalizeHeatmapShape(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((item) => Number.isInteger(item) && item > 0)
  ) {
    throw invalidHeatmapResponse(
      "TokenPath heatmap shape must contain two positive integers."
    );
  }
  return [value[0], value[1]];
}

function normalizeHeatmapIndices(value, field, upperBound) {
  if (!Array.isArray(value)) {
    throw invalidHeatmapResponse(
      `TokenPath heatmap ${field} must be an array.`
    );
  }
  return value.map((item) => {
    if (!Number.isInteger(item) || item < 0 || item >= upperBound) {
      throw invalidHeatmapResponse(
        `TokenPath heatmap ${field} contains an out-of-range token index.`
      );
    }
    return item;
  });
}

function normalizeHeatmapScores(value) {
  if (!Array.isArray(value)) {
    throw invalidHeatmapResponse("TokenPath heatmap data must be an array.");
  }
  return value.map((item) => {
    if (
      typeof item !== "number" ||
      !Number.isFinite(item) ||
      item < 0 ||
      item > 1
    ) {
      throw invalidHeatmapResponse(
        "TokenPath heatmap data contains an invalid attribution score."
      );
    }
    return item;
  });
}

function normalizeHeatmapOffsets(value, field, expectedLength, utf16Map) {
  if (!Array.isArray(value) || value.length !== expectedLength) {
    throw invalidHeatmapResponse(
      `TokenPath heatmap ${field} does not match its matrix dimension.`
    );
  }

  const maxCodePointOffset = utf16Map.length - 1;
  return value.map((range) => {
    if (
      !Array.isArray(range) ||
      range.length !== 2 ||
      !Number.isInteger(range[0]) ||
      !Number.isInteger(range[1]) ||
      range[0] < 0 ||
      range[1] < range[0] ||
      range[1] > maxCodePointOffset
    ) {
      throw invalidHeatmapResponse(
        `TokenPath heatmap ${field} contains an invalid character range.`
      );
    }

    const start = TldrPanelLogic.codePointOffsetToUtf16(utf16Map, range[0]);
    const end = TldrPanelLogic.codePointOffsetToUtf16(utf16Map, range[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw invalidHeatmapResponse(
        `TokenPath heatmap ${field} could not be converted to UTF-16.`
      );
    }
    return [start, end];
  });
}

function formatTokens(n) {
  if (n == null) return "";
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}
