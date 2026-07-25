import { chromium } from "playwright";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// If setup-libs.sh vendored the extra shared libs (no-root environments),
// point the child Chromium process at them automatically.
const vendored = join(__dirname, "_libs", "flat");
if (existsSync(vendored)) {
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${vendored}:${process.env.LD_LIBRARY_PATH}`
    : vendored;
}

// Load the real content script (../content.js relative to this test file).
const CONTENT_JS = readFileSync(join(__dirname, "..", "content.js"), "utf8");
const PANEL_URL = pathToFileURL(
  join(__dirname, "..", "sidepanel", "panel.html")
).href;

const SITES = [
  "https://example.com",
  "https://en.wikipedia.org/wiki/Web_browser",
  "https://www.gnu.org/philosophy/free-sw.html",
  "https://developer.mozilla.org/en-US/docs/Web/HTML/Element/p",
  "https://news.ycombinator.com",
  "https://bfl.ai/blog/flux-3",
  "https://taekim.substack.com/p/taes-new-substack-launches-today",
  "https://x.com/nasa", // expect a login/anti-bot wall — included to show the limit
];

// Mirror of the panel.js stub block-splitting, so we attribute the same way
// the real UI does (headings, first-sentence-per-block).
function stubAttribs(context) {
  const blocks = [];
  let cursor = 0;
  for (const raw of context.split("\n")) {
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) blocks.push({ text: trimmed, start: cursor + leading });
    cursor += raw.length + 1;
  }
  return blocks.slice(0, 8).map((b) => {
    const m = b.text.match(/^[\s\S]*?[.!?](?=\s|$)/);
    const sentence = m ? m[0] : b.text;
    return { sourceStart: b.start, sourceEnd: b.start + sentence.length, sentence };
  });
}

const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

async function setupPage(page) {
  // chrome shim must exist before content.js registers its listener.
  await page.evaluate(() => {
    window.chrome = {
      runtime: {
        onMessage: { addListener: (fn) => (window.__tldrMsg = fn) },
      },
    };
  });
  // Inject via evaluate (Runtime.evaluate) rather than a <script> tag so we
  // are exempt from page CSP — mirroring how a real content script runs in an
  // isolated world. content.js is an IIFE expression, so it evaluates cleanly.
  await page.evaluate(CONTENT_JS);
}

// Select a range and fire the same messages background.js would.
async function captureRegion(page, mode) {
  return page.evaluate((mode) => {
    // find candidate text nodes
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) {
      const t = n.data.replace(/\s+/g, " ").trim();
      if (t.length >= 3 && n.parentElement && n.parentElement.offsetParent !== null) {
        nodes.push(n);
      }
      if (nodes.length > 400) break;
    }
    if (!nodes.length) return { error: "no text nodes on page" };

    const sel = window.getSelection();
    sel.removeAllRanges();
    const range = document.createRange();

    if (mode === "single") {
      // A selection entirely inside ONE text node (the x.com failure shape).
      const node = nodes.find((x) => x.data.trim().length >= 40) || nodes[0];
      const s = node.data.search(/\S/);
      range.setStart(node, Math.max(0, s));
      range.setEnd(node, Math.min(node.data.length, s + 35));
    } else {
      // A multi-block region: first node .. a node ~15 later (spans headings).
      const a = nodes[0];
      const b = nodes[Math.min(nodes.length - 1, 15)];
      range.setStart(a, a.data.search(/\S/) < 0 ? 0 : a.data.search(/\S/));
      range.setEnd(b, b.data.length);
    }
    sel.addRange(range);

    // content.js snapshots the selection on contextmenu.
    document.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

    let resp;
    window.__tldrMsg({ type: "capture-selection" }, null, (r) => (resp = r));
    return resp;
  }, mode);
}

async function highlight(page, start, end) {
  return page.evaluate(
    ({ start, end }) => {
      let resp;
      window.__tldrMsg({ type: "highlight", start, end }, null, (r) => (resp = r));
      const hl = CSS.highlights ? CSS.highlights.get("tldr-attrib") : null;
      const ranges = hl ? [...hl].map((r) => r.toString()) : [];
      return { resp, ranges };
    },
    { start, end }
  );
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
let totalPass = 0,
  totalFail = 0,
  deterministicFail = 0;

function recordDeterministic(good) {
  if (good) {
    totalPass++;
  } else {
    totalFail++;
    deterministicFail++;
  }
}

// Side-panel regression: TokenPath streams a Markdown answer, is called once
// for the whole-answer heatmap, and resolves every later answer selection
// locally from that cache before routing to the original page frame.
{
  const page = await browser.newPage();
  try {
    await page.setViewportSize({ width: 360, height: 720 });
    await page.addInitScript(() => {
      const source =
        "Fable 5 appeared during the first preview with early concept art, an initial cast reveal, and a long discussion of the team's ambitions 🎓. " +
        "Several years of production updates followed while the studio refined combat, quests, characters, and accessibility across every supported platform. " +
        "Later, after a new showcase, Fable 5 shipped worldwide to players and reviewers.";
      const cases = {
        "inline code case": {
          answer: "Inline: use `Fable 5` now.",
          start: "Fable 5",
          end: "Fable 5",
        },
        "fenced code case": {
          answer: "```txt\nFable 5\n```",
          start: "Fable 5",
          end: "Fable 5",
        },
        "indented code case": {
          answer: "Example:\n\n    Fable 5\n    launch complete",
          start: "Fable 5",
          end: "launch",
        },
        "link label case": {
          answer: "[Fable 5](https://example.com)",
          start: "Fable 5",
          end: "Fable 5",
        },
        "delimiter crossing case": {
          answer: "**Fable 5** launch complete",
          start: "Fable 5",
          end: "launch",
        },
        "block crossing case": {
          answer: "Fable 5\n\n- launch complete",
          start: "Fable 5",
          end: "launch",
        },
        "entity case": {
          answer: "Fable 5 &amp; launch",
          start: "Fable 5",
          end: "launch",
        },
        "entity exact case": {
          answer: "Symbol: &copy;",
          start: "&copy;",
          end: "&copy;",
        },
        "hidden link destination case": {
          answer:
            "[details](https://example.com/Fable%205) followed by Fable 5",
          start: "Fable 5",
          end: "Fable 5",
          occurrence: "last",
        },
        "hidden image alt case": {
          answer: "![Fable 5](https://example.com/image.png)\n\nFable 5",
          start: "Fable 5",
          end: "Fable 5",
          occurrence: "last",
        },
        "footnote definition case": {
          answer: "Claim[^1]\n\n[^1]: Fable 5 note 1 detail",
          start: "Fable 5",
          end: "detail",
        },
        "unicode markdown case": {
          answer: "Result: **🎓漢字** shipped.",
          start: "🎓漢字",
          end: "🎓漢字",
        },
      };
      // Deliberately exceeds the old client-side summary budget. The terminal
      // answer must remain byte-for-byte canonical instead of being replaced
      // with an extractive prefix from `source`.
      const fallback = {
        answer:
          "## Launch\n\nThe final streamed summary says **Fable 5** shipped " +
          "[worldwide](https://example.com) after years of development, " +
          "covering combat, quests, characters, accessibility, production " +
          "updates, reviews, and final launch preparation.\n\n" +
          "![tracking](https://tracker.invalid/pixel.png)\n",
        start: "Fable 5",
        end: "Fable 5",
      };
      const codePointOffset = (text, utf16Offset) =>
        Array.from(text.slice(0, utf16Offset)).length;
      const responseJson = (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      const sseResponse = (answer, streamedAnswer = answer) => {
        const split = Math.max(1, Math.floor(streamedAnswer.length / 2));
        const encoder = new TextEncoder();
        const event = (content, finishReason = null) =>
          "event: delta\n" +
          "data: " +
          JSON.stringify({
            text: content,
          }) +
          "\n\n";
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                ": TOKENPATH PROCESSING\n\n" +
                  event(streamedAnswer.slice(0, split))
              )
            );
            setTimeout(() => {
              controller.enqueue(
                encoder.encode(
                  event(streamedAnswer.slice(split), "stop") +
                    "event: done\n" +
                    "data: " +
                    JSON.stringify({
                      answer,
                      model: "google/gemini-3.1-flash-lite",
                      usage: {
                        input_tokens: 42,
                        output_tokens: 12,
                        billed_tokens: 39,
                      },
                      credits_remaining: 99_999_961,
                    }) +
                    "\n\n"
                )
              );
              controller.close();
            }, 12);
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      };

      window.__panelSource = source;
      window.__panelCanonicalSummary = fallback.answer;
      window.__panelSent = [];
      window.__panelRequests = [];
      const runtimeListeners = [];
      window.__panelRuntimeListeners = runtimeListeners;
      const localStore = {
        tokenpathKey: "tpk_test",
      };
      window.chrome = {
        tabs: {
          query: () =>
            new Promise((resolve) => {
              window.__resolvePanelQuery = resolve;
            }),
          sendMessage: async (...args) => {
            window.__panelSent.push(args);
            return { ok: true };
          },
          onUpdated: { addListener() {} },
          onRemoved: { addListener() {} },
        },
        runtime: {
          onMessage: {
            addListener(listener) {
              runtimeListeners.push(listener);
            },
          },
        },
        storage: {
          local: {
            async get(keys) {
              const requested = Array.isArray(keys) ? keys : [keys];
              return Object.fromEntries(
                requested
                  .filter((key) => key in localStore)
                  .map((key) => [key, localStore[key]])
              );
            },
            async set(values) {
              Object.assign(localStore, values);
            },
            async remove(key) {
              if (key === "tokenpathKey" && window.__delayTokenPathRemoval) {
                await new Promise((resolve) => {
                  window.__resolveTokenPathRemoval = resolve;
                });
              }
              delete localStore[key];
            },
          },
          session: {
            async get(key) {
              return {
                [key]: {
                  captureId: "seed-1",
                  capturedAt: 1,
                  tabId: 42,
                  windowId: 3,
                  frameId: 9,
                  url: "https://news.example/articles/fable-5?preview=true",
                  text: source,
                  error: null,
                },
              };
            },
          },
        },
      };

      window.fetch = async (url, options = {}) => {
        const path = String(url);
        const request = options.body ? JSON.parse(options.body) : null;
        if (path.endsWith("/v1/me/credits")) {
          return new Promise(() => {});
        }
        window.__panelRequests.push({ path, request });
        if (path.endsWith("/v1/generate")) {
          const question =
            [...(request.messages || [])]
              .reverse()
              .find((message) => message.role === "user")?.content || "";
          const selected = cases[question] || fallback;
          return sseResponse(
            selected.answer,
            // Exercise controller finalization too: transient deltas may differ
            // from the terminal `done.answer`, which owns the canonical result.
            question.includes("summary of the given text")
              ? "Temporary streamed draft."
              : selected.answer
          );
        }
        if (path.endsWith("/v1/attributions/heatmap")) {
          const selected = cases[request.question] || fallback;
          const answerRanges = [
            [selected.start, selected.end],
            ...(request.answer.includes("worldwide")
              ? [["worldwide", "worldwide"]]
              : []),
          ].map(([startText, endText]) => {
            const occurrence = selected.occurrence || "first";
            const start =
              occurrence === "last"
                ? request.answer.lastIndexOf(startText)
                : request.answer.indexOf(startText);
            const endStart =
              occurrence === "last"
                ? request.answer.lastIndexOf(endText)
                : request.answer.indexOf(endText, start);
            const end = endStart + endText.length;
            return [
              codePointOffset(request.answer, start),
              codePointOffset(request.answer, end),
            ];
          });
          const sourceTerms = answerRanges.length === 2
            ? ["Fable 5", "worldwide"]
            : ["Fable 5"];
          const documentRanges = sourceTerms.map((term) => {
            const start = request.document.lastIndexOf(term);
            // Return an intentionally narrow token range. The frontend's port
            // of TokenPath's resolver must word-snap and verbatim-disambiguate.
            return [
              codePointOffset(request.document, start + 1),
              codePointOffset(
                request.document,
                start + Math.max(2, term.length - 1)
              ),
            ];
          });
          return responseJson({
            row: answerRanges.map((_, index) => index),
            col: documentRanges.map((_, index) => index),
            data: answerRanges.map((_, index) => 0.94 - index * 0.06),
            shape: [answerRanges.length, documentRanges.length],
            answer_offsets: answerRanges,
            document_offsets: documentRanges,
          });
        }
        return responseJson({}, 404);
      };
    });
    await page.goto(PANEL_URL);
    await page.waitForFunction(
      () =>
        document
          .getElementById("context-text")
          ?.textContent?.includes("Waiting for a selection")
    );
    const pendingSourceState = await page.evaluate(() => {
      const context = document.getElementById("context-text");
      return {
        hasToggle: !!document.getElementById("context-toggle"),
        hidden: context?.hidden,
        visible: context?.getClientRects().length === 1,
      };
    });
    await page.evaluate(() => {
      window.__panelRuntimeListeners[0]?.({
        type: "selection-captured",
        captureId: "seed-1",
        capturedAt: 1,
        tabId: 42,
        windowId: 3,
        frameId: 9,
        url: "https://news.example/articles/fable-5?preview=true",
        text: window.__panelSource,
        error: null,
      });
      window.__resolvePanelQuery([
        {
          id: 42,
          windowId: 3,
          url: "https://news.example/articles/fable-5?preview=true",
        },
      ]);
    });
    await page.waitForFunction(
      () =>
        document
          .getElementById("context-text")
          ?.textContent.startsWith("Fable 5") &&
        document.querySelector('[data-answer-status="ready"]')
    );
    const collapsedSourceState = await page.evaluate(() => {
      const card = document.getElementById("context");
      const context = document.getElementById("context-text");
      const summaryLength = document.getElementById("summary-length");
      const toggle = document.getElementById("context-toggle");
      return {
        ariaControls: toggle?.getAttribute("aria-controls"),
        ariaExpanded: toggle?.getAttribute("aria-expanded"),
        cardHeight: card?.getBoundingClientRect().height || 0,
        contextHidden: context?.hidden,
        contextVisible: context?.getClientRects().length === 1,
        hasButton:
          toggle instanceof HTMLButtonElement && toggle.type === "button",
        summaryVisible: summaryLength?.getClientRects().length === 1,
      };
    });
    await page.locator("#summary-length").focus();
    const sourceStaysCollapsedOnSummaryFocus = await page.evaluate(
      () =>
        document.getElementById("context-text")?.hidden === true &&
        document
          .getElementById("context-toggle")
          ?.getAttribute("aria-expanded") === "false"
    );
    await page.locator("#context-toggle").click();
    const expandedSourceState = await page.evaluate(() => {
      const context = document.getElementById("context-text");
      const toggle = document.getElementById("context-toggle");
      return {
        ariaExpanded: toggle?.getAttribute("aria-expanded"),
        context: context?.textContent || "",
        contextHidden: context?.hidden,
        contextVisible: context?.getClientRects().length === 1,
      };
    });
    await page.locator("#context-toggle").click();
    const sourceRecollapsed = await page.evaluate(
      () =>
        document.getElementById("context-text")?.hidden === true &&
        document
          .getElementById("context-toggle")
          ?.getAttribute("aria-expanded") === "false"
    );
    if (process.env.TLDR_PANEL_SCREENSHOT_PREFIX) {
      const setThemePreference = async (preference) => {
        for (let index = 0; index < 4; index++) {
          const label = await page
            .locator("#theme-toggle")
            .getAttribute("aria-label");
          if (label?.startsWith(`Theme: ${preference}`)) return;
          await page.locator("#theme-toggle").click();
          await page.waitForTimeout(0);
        }
        throw new Error(`Could not switch panel to ${preference} theme`);
      };
      for (const theme of ["light", "dark"]) {
        await setThemePreference(theme);
        await page.screenshot({
          path: `${process.env.TLDR_PANEL_SCREENSHOT_PREFIX}-${theme}.png`,
        });
      }
      await setThemePreference("system");
    }

    async function selectAnswerText(startText, endText = startText) {
      const before = await page.evaluate(() => window.__panelSent.length);
      await page.evaluate(
        ({ startText, endText }) => {
          const root = [
            ...document.querySelectorAll("[data-answer-content]"),
          ].at(-1);
          const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT
          );
          const nodes = [];
          let node;
          while ((node = walker.nextNode())) nodes.push(node);
          const startNode = nodes.find((candidate) =>
            candidate.data.includes(startText)
          );
          const startIndex = startNode?.data.indexOf(startText) ?? -1;
          const startPosition = nodes.indexOf(startNode);
          const endNode = nodes
            .slice(Math.max(0, startPosition))
            .find((candidate) => candidate.data.includes(endText));
          const endIndex = endNode?.data.indexOf(endText) ?? -1;
          if (!startNode || !endNode || startIndex < 0 || endIndex < 0) {
            throw new Error(`Could not select ${startText}..${endText}`);
          }
          const range = document.createRange();
          range.setStart(startNode, startIndex);
          range.setEnd(endNode, endIndex + endText.length);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          root.dispatchEvent(
            new PointerEvent("pointerup", { bubbles: true, button: 0 })
          );
        },
        { startText, endText }
      );
      await page.waitForFunction(
        (count) => window.__panelSent.length > count,
        before
      );
      return page.evaluate(() => window.__panelSent.at(-1));
    }

    const firstHeatmapCount = await page.evaluate(
      () =>
        window.__panelRequests.filter((item) =>
          item.path.endsWith("/v1/attributions/heatmap")
        ).length
    );
    const firstSent = await selectAnswerText("Fable 5");
    const secondSent = await selectAnswerText("worldwide");
    const realLinkBefore = await page.evaluate(
      () => window.__panelSent.length
    );
    const realLink = page
      .locator('[data-answer-content] [data-streamdown="link"]')
      .first();
    await realLink.scrollIntoViewIfNeeded();
    const linkBox = await realLink.boundingBox();
    if (!linkBox) throw new Error("Markdown link was not rendered");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.mouse.move(linkBox.x + 2, linkBox.y + linkBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      linkBox.x + linkBox.width - 2,
      linkBox.y + linkBox.height / 2,
      { steps: 8 }
    );
    await page.mouse.up();
    await page.waitForFunction(
      (count) => window.__panelSent.length > count,
      realLinkBefore
    );
    const realLinkSent = await page.evaluate(() => window.__panelSent.at(-1));
    const cachedHeatmapCount = await page.evaluate(
      () =>
        window.__panelRequests.filter((item) =>
          item.path.endsWith("/v1/attributions/heatmap")
        ).length
    );

    const boundaryCases = [];
    for (const [question, startText, endText, selector] of [
      ["inline code case", "Fable 5", "Fable 5", "code"],
      ["fenced code case", "Fable 5", "Fable 5", '[data-streamdown="code-block"]'],
      ["indented code case", "Fable 5", "launch", '[data-streamdown="code-block"]'],
      ["link label case", "Fable 5", "Fable 5", '[data-streamdown="link"]'],
      ["delimiter crossing case", "Fable 5", "launch", '[data-streamdown="strong"]'],
      ["block crossing case", "Fable 5", "launch", "li"],
      ["entity case", "Fable 5", "launch", "[data-answer-content]"],
      ["entity exact case", "©", "©", "[data-answer-content]"],
      ["hidden link destination case", "Fable 5", "Fable 5", "[data-answer-content]"],
      ["hidden image alt case", "Fable 5", "Fable 5", "[data-answer-content]"],
      ["footnote definition case", "Fable 5", "detail", "[data-footnotes]"],
      ["unicode markdown case", "🎓漢字", "🎓漢字", '[data-streamdown="strong"]'],
    ]) {
      await page.locator("#input").fill(question);
      await page.locator("#send").click();
      await page.waitForFunction(
        (expectedQuestion) =>
          window.__panelRequests.some(
            (item) =>
              item.path.endsWith("/v1/attributions/heatmap") &&
              item.request?.question === expectedQuestion
          ) &&
          [...document.querySelectorAll("[data-answer-status]")].at(-1)
            ?.dataset.answerStatus === "ready",
        question
      );
      const sent = await selectAnswerText(startText, endText);
      const rendered = await page.evaluate(
        (selector) =>
          !![...document.querySelectorAll(".is-assistant")]
            .at(-1)
            ?.querySelector(selector),
        selector
      );
      boundaryCases.push({
        question,
        good:
          rendered &&
          sent?.[1]?.type === "highlight" &&
          sent?.[2]?.frameId === 9,
      });
    }

    await page.setViewportSize({ width: 320, height: 720 });
    const panelResult = await page.evaluate(async () => {
      window.__panelRuntimeListeners[0]?.({
        type: "selection-captured",
        captureId: "stale-seed",
        capturedAt: 0,
        tabId: 77,
        windowId: 3,
        frameId: 12,
        text: "stale",
      });
      const generation = window.__panelRequests.find((item) =>
        item.path.endsWith("/v1/generate")
      );
      const themeButton = document.getElementById("theme-toggle");
      const themeLabels = [themeButton?.getAttribute("aria-label")];
      for (let index = 0; index < 3; index++) {
        themeButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        themeLabels.push(themeButton?.getAttribute("aria-label"));
      }
      const cta = document.getElementById("tokenpath-cta");
      const disconnect = document.getElementById("disconnect");
      const wordmarkLink = document.querySelector(".tokenpath-wordmark-link");
      cta?.focus();
      const ctaRect = cta?.getBoundingClientRect();
      const disconnectRect = disconnect?.getBoundingClientRect();
      const wordmarkLinkRect = wordmarkLink?.getBoundingClientRect();
      const generationRequests = window.__panelRequests.filter((item) =>
        item.path.endsWith("/v1/generate")
      );
      const heatmapRequests = window.__panelRequests.filter((item) =>
        item.path.endsWith("/v1/attributions/heatmap")
      );
      return {
        autoHeatmapAnswer: heatmapRequests[0]?.request?.answer,
        canonicalSummary: window.__panelCanonicalSummary,
        context: document.getElementById("context-text").textContent,
        displayedSummary:
          document.querySelector("[data-answer-content]")?.textContent || "",
        followupHistory:
          generationRequests[1]?.request?.messages?.slice(-3) || [],
        followupHistoryAnswer: generationRequests[1]?.request?.messages?.find(
          (message) => message.role === "assistant"
        )?.content,
        generation,
        summaryLength:
          document.getElementById("summary-length")?.value || null,
        summaryLengthOptions: [
          ...(document.getElementById("summary-length")?.options || []),
        ].map((option) => option.value),
        hasTokenPathWordmark:
          document.querySelector(".tokenpath-wordmark")?.textContent ===
            "tokenpath" &&
          document.querySelector(".product-name")?.textContent === "TLDR",
        hasTokenRail:
          document.querySelector(".token-rail")?.getBoundingClientRect()
            .height === 2,
        hasUsableWordmarkTarget:
          wordmarkLink instanceof HTMLAnchorElement &&
          wordmarkLinkRect?.height >= 24,
        cta:
          cta instanceof HTMLAnchorElement
            ? {
                ariaLabel: cta.getAttribute("aria-label"),
                focused: document.activeElement === cta,
                href: cta.href,
                rel: cta.rel,
                target: cta.target,
                text: cta.textContent?.trim(),
              }
            : null,
        ctaDoesNotOverlapDisconnect:
          !ctaRect ||
          !disconnectRect ||
          ctaRect.right + 4 <= disconnectRect.left,
        hasMarkdownHeading:
          document.querySelector('[data-streamdown="heading-2"]')?.textContent ===
          "Launch",
        hasMarkdownStrong:
          document.querySelector('[data-streamdown="strong"]')?.textContent ===
          "Fable 5",
        hasSafeMarkdownLink:
          document.querySelector('[data-streamdown="link"]')?.textContent ===
          "worldwide",
        blocksRemoteMarkdownImage: !document.querySelector(
          'img[src*="tracker.invalid"]'
        ),
        hasFixedSpans: !!document.querySelector(".attrib"),
        hasSelectionHint:
          document
            .querySelector('[data-answer-status="ready"]')
            ?.textContent.includes("Select any text to find its source") || false,
        themeLabels,
        fitsNarrowPanel:
          document.documentElement.scrollWidth <=
            document.documentElement.clientWidth &&
          document.getElementById("composer")?.getBoundingClientRect().width <=
            window.innerWidth - 20 &&
          document.getElementById("context")?.scrollWidth <=
            document.getElementById("context")?.clientWidth,
      };
    });
    await page.locator("#summary-length").selectOption("high");
    const savedSummaryLength = await page.evaluate(() =>
      localStorage.getItem("tldr-summary-length")
    );
    const generationCountBeforeOpaqueOrigin = await page.evaluate(
      () =>
        window.__panelRequests.filter((item) =>
          item.path.endsWith("/v1/generate")
        ).length
    );
    await page.locator("#context-toggle").click();
    const sourceExpandedBeforeReplacement = await page.evaluate(
      () =>
        document
          .getElementById("context-toggle")
          ?.getAttribute("aria-expanded") === "true"
    );
    await page.evaluate(() => {
      window.__panelRuntimeListeners[0]?.({
        type: "selection-captured",
        captureId: "opaque-origin-seed",
        capturedAt: 2,
        tabId: 42,
        windowId: 3,
        frameId: 9,
        url: "file:///Users/private/document.html",
        text: Array.from(
          { length: 30 },
          (_, index) => `replacement${index}`
        ).join(" "),
        error: null,
      });
    });
    await page.waitForFunction(
      (previousCount) =>
        window.__panelRequests.filter((item) =>
          item.path.endsWith("/v1/generate")
        ).length > previousCount,
      generationCountBeforeOpaqueOrigin
    );
    await page.waitForFunction(
      () =>
        document
          .getElementById("context-text")
          ?.textContent?.startsWith("replacement0") &&
        document.getElementById("context-text")?.hidden === true &&
        document
          .getElementById("context-toggle")
          ?.getAttribute("aria-expanded") === "false"
    );
    const replacementSourceCollapsed = await page.evaluate(
      () =>
        document.getElementById("context-text")?.hidden === true &&
        document
          .getElementById("context-toggle")
          ?.getAttribute("aria-expanded") === "false"
    );
    const opaqueOriginGeneration = await page.evaluate(() => {
      const generation = window.__panelRequests
        .filter((item) => item.path.endsWith("/v1/generate"))
        .at(-1);
      const messages = generation?.request?.messages || [];
      return {
        maxOutputTokens: generation?.request?.max_output_tokens,
        systemPrompt: messages.find((message) => message.role === "system")
          ?.content,
        userPrompt: messages.at(-1)?.content,
      };
    });
    await page.locator("#summary-length").selectOption("low");
    await page.evaluate(() => {
      window.__delayTokenPathRemoval = true;
      document.getElementById("disconnect")?.click();
    });
    await page.waitForFunction(
      () =>
        document.getElementById("tokenpath-key")?.disabled === true &&
        document.getElementById("auth-connect")?.disabled === true
    );
    const disconnectPending = await page.evaluate(
      () =>
        document.getElementById("tokenpath-key")?.disabled === true &&
        document.getElementById("auth-connect")?.disabled === true
    );
    await page.evaluate(() => window.__resolveTokenPathRemoval?.());
    await page.waitForFunction(
      () => document.getElementById("tokenpath-key")?.disabled === false
    );
    const disconnectSettled = await page.evaluate(
      () =>
        document.getElementById("tokenpath-key")?.disabled === false &&
        document.getElementById("auth")?.hidden === false &&
        document.getElementById("tokenpath-cta")?.getClientRects().length === 1
    );
    const sourceError =
      "The page changed before the selection could be captured.";
    await page.evaluate((error) => {
      window.__panelRuntimeListeners[0]?.({
        type: "selection-captured",
        captureId: "source-error-seed",
        capturedAt: 3,
        tabId: 42,
        windowId: 3,
        frameId: 9,
        url: "https://news.example/articles/fable-5?preview=true",
        text: "",
        error,
      });
    }, sourceError);
    await page.waitForFunction(
      (error) =>
        document.getElementById("context-text")?.textContent === error,
      sourceError
    );
    const sourceErrorState = await page.evaluate(() => {
      const context = document.getElementById("context-text");
      return {
        context: context?.textContent || "",
        hidden: context?.hidden,
        hasToggle: !!document.getElementById("context-toggle"),
        summaryVisible:
          document.getElementById("summary-length")?.getClientRects().length ===
          1,
        visible: context?.getClientRects().length === 1,
      };
    });

    const firstMessage = firstSent?.[1];
    const firstOptions = firstSent?.[2];
    const secondMessage = secondSent?.[1];
    const expectedFable = panelResult.context.lastIndexOf("Fable 5");
    const expectedWorldwide = panelResult.context.lastIndexOf("worldwide");
    const generationBody = panelResult.generation?.request || {};
    const generationMessages = generationBody.messages || [];
    const systemPrompt = generationMessages.find(
      (message) => message.role === "system"
    )?.content;
    const summaryPrompt = generationMessages.at(-1)?.content;
    const good =
      pendingSourceState.hasToggle === false &&
      pendingSourceState.hidden === false &&
      pendingSourceState.visible &&
      collapsedSourceState.hasButton &&
      collapsedSourceState.ariaControls === "context-text" &&
      collapsedSourceState.ariaExpanded === "false" &&
      collapsedSourceState.contextHidden === true &&
      collapsedSourceState.contextVisible === false &&
      collapsedSourceState.summaryVisible &&
      collapsedSourceState.cardHeight <= 52 &&
      sourceStaysCollapsedOnSummaryFocus &&
      expandedSourceState.ariaExpanded === "true" &&
      expandedSourceState.context === panelResult.context &&
      expandedSourceState.contextHidden === false &&
      expandedSourceState.contextVisible &&
      sourceRecollapsed &&
      sourceExpandedBeforeReplacement &&
      replacementSourceCollapsed &&
      sourceErrorState.context === sourceError &&
      sourceErrorState.hidden === false &&
      sourceErrorState.hasToggle === false &&
      sourceErrorState.summaryVisible &&
      sourceErrorState.visible &&
      firstHeatmapCount === 1 &&
      cachedHeatmapCount === 1 &&
      !panelResult.hasFixedSpans &&
      panelResult.hasSelectionHint &&
      panelResult.hasMarkdownHeading &&
      panelResult.hasMarkdownStrong &&
      panelResult.displayedSummary.includes(
        "The final streamed summary says Fable 5 shipped"
      ) &&
      panelResult.displayedSummary.includes("final launch preparation.") &&
      !panelResult.displayedSummary.includes("Temporary streamed draft") &&
      (panelResult.canonicalSummary.trim().match(/\S+/g)?.length || 0) > 16 &&
      panelResult.autoHeatmapAnswer === panelResult.canonicalSummary &&
      panelResult.followupHistoryAnswer === panelResult.canonicalSummary &&
      panelResult.followupHistory[0]?.role === "user" &&
      panelResult.followupHistory[0]?.content === summaryPrompt &&
      panelResult.followupHistory[1]?.role === "assistant" &&
      panelResult.followupHistory[1]?.content === panelResult.canonicalSummary &&
      panelResult.followupHistory[2]?.role === "user" &&
      panelResult.followupHistory[2]?.content === "inline code case" &&
      panelResult.hasSafeMarkdownLink &&
      panelResult.blocksRemoteMarkdownImage &&
      panelResult.fitsNarrowPanel &&
      panelResult.hasTokenPathWordmark &&
      panelResult.hasTokenRail &&
      panelResult.hasUsableWordmarkTarget &&
      panelResult.cta?.text === "Build with TokenPath" &&
      panelResult.cta?.ariaLabel?.startsWith(panelResult.cta.text) &&
      panelResult.cta?.ariaLabel?.includes("source attribution") &&
      panelResult.cta?.focused === true &&
      panelResult.cta?.href.startsWith(
        "https://tokenpath.ai/?utm_source=tldr-extension"
      ) &&
      panelResult.cta?.target === "_blank" &&
      panelResult.cta?.rel.includes("noopener") &&
      panelResult.cta?.rel.includes("noreferrer") &&
      panelResult.ctaDoesNotOverlapDisconnect &&
      disconnectPending &&
      disconnectSettled &&
      panelResult.themeLabels.some((label) => label?.startsWith("Theme: light")) &&
      panelResult.themeLabels.some((label) => label?.startsWith("Theme: dark")) &&
      panelResult.themeLabels.some((label) => label?.startsWith("Theme: system")) &&
      Array.isArray(generationBody.messages) &&
      systemPrompt?.startsWith(
        "You are given some text from https://news.example. " +
          "Answer the user's question."
      ) &&
      systemPrompt?.includes(
        "- Prefer bullet points when they make the answer easier to scan."
      ) &&
      systemPrompt?.includes(
        "- Use a Markdown table when the information is naturally tabular"
      ) &&
      !systemPrompt?.includes("/articles/fable-5") &&
      !systemPrompt?.includes("preview=true") &&
      !systemPrompt?.includes("citations") &&
      !systemPrompt?.includes("source labels") &&
      !systemPrompt?.includes("[[...]]") &&
      opaqueOriginGeneration.systemPrompt?.startsWith(
        "You are given some text from the current webpage. " +
          "Answer the user's question."
      ) &&
      !opaqueOriginGeneration.systemPrompt?.includes("news.example") &&
      !opaqueOriginGeneration.systemPrompt?.includes("/Users/private") &&
      panelResult.summaryLength === "low" &&
      panelResult.summaryLengthOptions.join(",") === "low,medium,high" &&
      savedSummaryLength === "high" &&
      summaryPrompt?.includes("Aim for 2-3 concise sentences") &&
      opaqueOriginGeneration.userPrompt?.includes(
        "Aim for 8-12 concise sentences"
      ) &&
      !("document" in generationBody) &&
      !("question" in generationBody) &&
      !("model" in generationBody) &&
      !("stream" in generationBody) &&
      generationBody.max_output_tokens === 512 &&
      opaqueOriginGeneration.maxOutputTokens === 1024 &&
      firstMessage?.type === "highlight" &&
      firstMessage?.start === expectedFable &&
      firstMessage?.end === expectedFable + 7 &&
      firstMessage?.captureId === "seed-1" &&
      secondMessage?.start === expectedWorldwide &&
      secondMessage?.end === expectedWorldwide + "worldwide".length &&
      realLinkSent?.[1]?.start === expectedWorldwide &&
      realLinkSent?.[1]?.end === expectedWorldwide + "worldwide".length &&
      firstSent?.[0] === 42 &&
      firstOptions?.frameId === 9 &&
      boundaryCases.every((item) => item.good);
    console.log("\n### Side-panel selection fixture");
    console.log(
      `  [stream + one heatmap + arbitrary Markdown selections] ${good ? "PASS" : "FAIL"}` +
        ` — calls=${firstHeatmapCount}/${cachedHeatmapCount}, frame=${firstOptions?.frameId}, ` +
        `source=${firstMessage?.start}/${secondMessage?.start}, markdown=${panelResult.hasMarkdownHeading}/${panelResult.hasMarkdownStrong}, ` +
        `canonical=${panelResult.autoHeatmapAnswer === panelResult.canonicalSummary}/${panelResult.followupHistoryAnswer === panelResult.canonicalSummary}, ` +
        `length=${panelResult.summaryLength}/${savedSummaryLength}, output=${generationBody.max_output_tokens}/${opaqueOriginGeneration.maxOutputTokens}, ` +
        `sourceCard=${collapsedSourceState.cardHeight.toFixed(0)}px/${expandedSourceState.contextVisible}/${replacementSourceCollapsed}/${sourceErrorState.visible}, ` +
        `brand=${panelResult.hasTokenPathWordmark}/${panelResult.hasTokenRail}, ` +
        `cta=${panelResult.cta?.text}/${panelResult.ctaDoesNotOverlapDisconnect}, ` +
        `boundaries=${boundaryCases.map((item) => `${item.question}:${item.good}`).join(",")}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Side-panel selection fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Controller stale-state regressions: an auth failure that pauses while the
// saved key is removed must not append its error card to a newer capture.
{
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      const oldSource = "Old selection stays short enough to skip its automatic summary.";
      const newSource = "New selection owns every message shown after the capture changes.";
      const responseJson = (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      const runtimeListeners = [];
      const localStore = { tokenpathKey: "tpk_stale_context" };

      window.__staleContextSource = newSource;
      window.__staleContextRuntimeListeners = runtimeListeners;
      window.chrome = {
        tabs: {
          async query() {
            return [{ id: 51, windowId: 7 }];
          },
          async sendMessage() {
            return { ok: true };
          },
          onUpdated: { addListener() {} },
          onRemoved: { addListener() {} },
        },
        runtime: {
          onMessage: {
            addListener(listener) {
              runtimeListeners.push(listener);
            },
          },
        },
        storage: {
          local: {
            async get(keys) {
              const requested = Array.isArray(keys) ? keys : [keys];
              return Object.fromEntries(
                requested
                  .filter((key) => key in localStore)
                  .map((key) => [key, localStore[key]])
              );
            },
            async set(values) {
              Object.assign(localStore, values);
            },
            async remove(key) {
              if (key === "tokenpathKey" && window.__delayRejectedKeyRemoval) {
                window.__rejectedKeyRemovalPending = true;
                await new Promise((resolve) => {
                  window.__resolveRejectedKeyRemoval = resolve;
                });
              }
              delete localStore[key];
            },
          },
          session: {
            async get(key) {
              return {
                [key]: {
                  captureId: "stale-context-1",
                  capturedAt: 1,
                  tabId: 51,
                  windowId: 7,
                  frameId: 0,
                  text: oldSource,
                  error: null,
                },
              };
            },
          },
        },
      };

      window.fetch = async (url) => {
        const path = String(url);
        if (path.endsWith("/v1/me/credits")) {
          return responseJson({ available_tokens: 1_000 });
        }
        if (path.endsWith("/v1/generate")) {
          return responseJson(
            {
              error: {
                code: "invalid_api_key",
                message: "The API key is invalid.",
                request_id: "req_stale_context",
              },
            },
            401
          );
        }
        return responseJson({}, 404);
      };
    });

    await page.goto(PANEL_URL);
    await page.waitForFunction(
      () =>
        document.getElementById("context-text")?.textContent?.startsWith("Old") &&
        document.getElementById("auth")?.hidden === true
    );
    await page.evaluate(() => {
      window.__delayRejectedKeyRemoval = true;
    });
    await page.locator("#input").fill("What does this say?");
    await page.locator("#send").click();
    await page.waitForFunction(() => window.__rejectedKeyRemovalPending === true);
    await page.evaluate(() => {
      window.__staleContextRuntimeListeners[0]?.({
        type: "selection-captured",
        captureId: "stale-context-2",
        capturedAt: 2,
        tabId: 51,
        windowId: 7,
        frameId: 0,
        text: window.__staleContextSource,
        error: null,
      });
      window.__resolveRejectedKeyRemoval?.();
    });
    await page.waitForFunction(
      () =>
        document.getElementById("context-text")?.textContent?.startsWith("New") &&
        document.getElementById("tokenpath-key")?.disabled === false
    );
    const result = await page.evaluate(() => ({
      context: document.getElementById("context-text")?.textContent || "",
      messages: [...document.querySelectorAll("#messages .is-assistant")].map(
        (element) => element.textContent || ""
      ),
      hasErrorCard: !!document.querySelector("#messages .message-error"),
    }));
    const good =
      result.context ===
        "New selection owns every message shown after the capture changes." &&
      result.messages.length === 1 &&
      result.messages[0].includes("Already concise") &&
      !result.messages.some((message) => message.includes("key was rejected")) &&
      !result.hasErrorCard;
    console.log("\n### Side-panel stale auth/context fixture");
    console.log(
      `  [old auth failure cannot write into new capture] ${good ? "PASS" : "FAIL"}` +
        ` — context="${result.context}", messages=${result.messages.length}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Side-panel stale auth/context fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Same-auth balance responses are sequenced, and rapid answer selections carry
// highlight ownership IDs so a late A response cannot clear newer highlight B.
{
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      const source =
        "Alpha begins the selected source while beta appears at the end.";
      const answer = "Alpha and beta.";
      const responseJson = (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      const doneStream = () =>
        new Response(
          "event: done\n" +
            "data: " +
            JSON.stringify({
              answer,
              model: "google/gemini-3.1-flash-lite",
              usage: {
                input_tokens: 30,
                output_tokens: 4,
                billed_tokens: 27,
              },
              credits_remaining: 900,
            }) +
            "\n\n",
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        );
      const localStore = { tokenpathKey: "tpk_sequence" };
      const runtimeListeners = [];

      window.__creditRequestCount = 0;
      window.__highlightMessages = [];
      window.__pendingHighlightResponses = [];
      window.__activeHighlightId = null;
      window.chrome = {
        tabs: {
          async query() {
            return [{ id: 62, windowId: 8 }];
          },
          sendMessage(_tabId, message) {
            window.__highlightMessages.push(message);
            if (message.type === "highlight") {
              window.__activeHighlightId = message.highlightId || null;
              return new Promise((resolve) => {
                window.__pendingHighlightResponses.push({ message, resolve });
              });
            }
            if (message.type === "clear-highlight") {
              const matches =
                !message.highlightId ||
                message.highlightId === window.__activeHighlightId;
              if (matches) window.__activeHighlightId = null;
              return Promise.resolve({ ok: matches });
            }
            return Promise.resolve({ ok: true });
          },
          onUpdated: { addListener() {} },
          onRemoved: { addListener() {} },
        },
        runtime: {
          onMessage: {
            addListener(listener) {
              runtimeListeners.push(listener);
            },
          },
        },
        storage: {
          local: {
            async get(keys) {
              const requested = Array.isArray(keys) ? keys : [keys];
              return Object.fromEntries(
                requested
                  .filter((key) => key in localStore)
                  .map((key) => [key, localStore[key]])
              );
            },
            async set(values) {
              Object.assign(localStore, values);
            },
            async remove(key) {
              delete localStore[key];
            },
          },
          session: {
            async get(key) {
              return {
                [key]: {
                  captureId: "sequence-seed",
                  capturedAt: 1,
                  tabId: 62,
                  windowId: 8,
                  frameId: 4,
                  text: source,
                  error: null,
                },
              };
            },
          },
        },
      };

      window.fetch = async (url) => {
        const path = String(url);
        if (path.endsWith("/v1/me/credits")) {
          window.__creditRequestCount++;
          if (window.__creditRequestCount === 1) {
            return new Promise((resolve) => {
              window.__resolveOldCreditRead = () =>
                resolve(responseJson({ available_tokens: 1_000 }));
            });
          }
          return responseJson({ available_tokens: 800 });
        }
        if (path.endsWith("/v1/generate")) return doneStream();
        if (path.endsWith("/v1/attributions/heatmap")) {
          const betaDocumentStart = source.indexOf("beta");
          return responseJson({
            row: [0, 1],
            col: [0, 1],
            data: [0.9, 0.8],
            shape: [2, 2],
            answer_offsets: [
              [0, 5],
              [10, 14],
            ],
            document_offsets: [
              [0, 5],
              [betaDocumentStart, betaDocumentStart + 4],
            ],
          });
        }
        return responseJson({}, 404);
      };
    });

    await page.goto(PANEL_URL);
    await page.waitForFunction(
      () =>
        document.getElementById("context-text")?.textContent?.startsWith("Alpha") &&
        document.getElementById("auth")?.hidden === true
    );
    await page.locator("#input").fill("Compare the two terms.");
    await page.locator("#send").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-answer-status="ready"]') &&
        document.getElementById("credits")?.textContent === "800 tokens"
    );

    const selectText = async (text) => {
      const prior = await page.evaluate(
        () => window.__pendingHighlightResponses.length
      );
      await page.evaluate((selectedText) => {
        const root = document.querySelector("[data-answer-content]");
        const walker = document.createTreeWalker(
          root,
          NodeFilter.SHOW_TEXT
        );
        let node;
        while ((node = walker.nextNode())) {
          const start = node.data.indexOf(selectedText);
          if (start === -1) continue;
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + selectedText.length);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          root.dispatchEvent(
            new PointerEvent("pointerup", { bubbles: true, button: 0 })
          );
          return;
        }
        throw new Error(`Could not select ${selectedText}`);
      }, text);
      await page.waitForFunction(
        (count) => window.__pendingHighlightResponses.length > count,
        prior
      );
    };

    await selectText("Alpha");
    await selectText("beta");
    await page.evaluate(() => {
      window.__pendingHighlightResponses[1].resolve({ ok: true });
    });
    await page.evaluate(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await page.evaluate(() => {
      window.__pendingHighlightResponses[0].resolve({ ok: true });
    });
    await page.waitForFunction(
      () =>
        window.__highlightMessages.filter(
          (message) => message.type === "clear-highlight"
        ).length >= 1
    );

    await page.evaluate(() => window.__resolveOldCreditRead?.());
    await page.waitForTimeout(30);
    const result = await page.evaluate(() => {
      const highlights = window.__highlightMessages.filter(
        (message) => message.type === "highlight"
      );
      const clears = window.__highlightMessages.filter(
        (message) => message.type === "clear-highlight"
      );
      return {
        activeHighlightId: window.__activeHighlightId,
        creditText: document.getElementById("credits")?.textContent || "",
        firstHighlightId: highlights[0]?.highlightId || null,
        secondHighlightId: highlights[1]?.highlightId || null,
        staleClearId: clears.at(-1)?.highlightId || null,
      };
    });
    const good =
      result.creditText === "800 tokens" &&
      result.firstHighlightId &&
      result.secondHighlightId &&
      result.firstHighlightId !== result.secondHighlightId &&
      result.staleClearId === result.firstHighlightId &&
      result.activeHighlightId === result.secondHighlightId;
    console.log("\n### Side-panel stale response sequencing fixture");
    console.log(
      `  [credit epoch + highlight ownership] ${good ? "PASS" : "FAIL"}` +
        ` — credits=${result.creditText}, active=${result.activeHighlightId}, staleClear=${result.staleClearId}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Side-panel stale response sequencing fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Gmail-shaped regression: nested scroll pane, inline spans + <br>, repeated
// text, and a message subtree replacement between capture and highlight.
{
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <style>
        #pane { height: 180px; overflow-y: auto; border: 1px solid; }
        .spacer { height: 620px; }
        [data-message-id] { min-height: 420px; font: 16px sans-serif; }
      </style>
      <div id="pane">
        <div class="spacer"></div>
        <div data-message-id="gmail-message-1">
          <div class="first">Fable <span>5</span> appeared in a preview.</div>
          <br>
          <div class="second">Later, Fable <span>5</span> shipped worldwide.</div>
        </div>
      </div>
    `);
    await setupPage(page);

    const captured = await page.evaluate(() => {
      const first = document.querySelector(".first").firstChild;
      const second = document.querySelector(".second").lastChild;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(second, second.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector(".second").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );
      let response;
      window.__tldrMsg(
        { type: "capture-selection", selectionText: selection.toString() },
        null,
        (value) => (response = value)
      );
      return response;
    });

    const secondStart = captured.text.lastIndexOf("Fable 5");
    const result = await page.evaluate(
      ({ source, start }) => {
        const oldMessage = document.querySelector("[data-message-id]");
        oldMessage.replaceWith(oldMessage.cloneNode(true));
        let response;
        window.__tldrMsg(
          {
            type: "highlight",
            start,
            end: start + 7,
          },
          null,
          (value) => (response = value)
        );
        const focus = CSS.highlights.get("tldr-attrib");
        const focusRange = focus && [...focus][0];
        const parent = focusRange?.startContainer?.parentElement;
        let ownedHighlight;
        window.__tldrMsg(
          {
            type: "highlight",
            start,
            end: start + 7,
            highlightId: "newer-highlight",
          },
          null,
          (value) => (ownedHighlight = value)
        );
        let staleClear;
        window.__tldrMsg(
          { type: "clear-highlight", highlightId: "older-highlight" },
          null,
          (value) => (staleClear = value)
        );
        const focusAfterStaleClear =
          [...(CSS.highlights.get("tldr-attrib") || [])][0]?.toString() || "";
        let matchingClear;
        window.__tldrMsg(
          { type: "clear-highlight", highlightId: "newer-highlight" },
          null,
          (value) => (matchingClear = value)
        );
        const clearedByOwner = !CSS.highlights.get("tldr-attrib");
        return {
          response,
          text: focusRange?.toString() || "",
          second: !!parent?.closest(".second"),
          scrollTop: document.getElementById("pane").scrollTop,
          source,
          ownedHighlight,
          staleClear,
          focusAfterStaleClear,
          matchingClear,
          clearedByOwner,
        };
      },
      { source: captured.text, start: secondStart }
    );

    const good =
      captured.text.includes("\n") &&
      secondStart > captured.text.indexOf("Fable 5") &&
      result.response?.ok &&
      result.text === "Fable 5" &&
      result.second &&
      result.scrollTop > 0 &&
      result.ownedHighlight?.ok &&
      result.staleClear?.ok === false &&
      result.focusAfterStaleClear === "Fable 5" &&
      result.matchingClear?.ok &&
      result.clearedByOwner;
    console.log("\n### Gmail-like dynamic message fixture");
    console.log(
      `  [frame content capture + remap + highlight] ${good ? "PASS" : "FAIL"}` +
        ` — focus="${result.text}", second=${result.second}, scroll=${result.scrollTop}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Gmail-like dynamic message fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// WhatsApp disables selection on its app shell, then explicitly re-enables
// message text. Capture a link-preview-to-image-caption selection across two
// bubbles while excluding metadata that remains genuinely unselectable.
{
  const page = await browser.newPage();
  try {
    const fixture = `
      <style>
        #app { user-select: none; }
        #main { width: 520px; }
        .message, .preview { display: block; margin: 8px; }
        .selectable-text { display: block; user-select: text; }
        .meta { user-select: text; }
        .controls { user-select: none; }
      </style>
      <div id="app">
        <section id="main">
          <div class="message" role="row" data-id="true_fixture_message_1">
            <div class="preview">
              <span id="preview-domain" class="selectable-text">github.com</span>
              <span class="selectable-text">https://github.com/everything3d/e3d-openscad-studio</span>
            </div>
            <div class="selectable-text">code is https://github.com/everything3d/e3d-openscad-studio push to main to deploy</div>
            <span class="meta">4:04 PM</span>
            <button class="controls">Reply</button>
          </div>
          <div class="message" role="row" data-id="true_fixture_message_2">
            <img alt="Community team sign" width="120" height="80">
            <div id="image-caption" class="selectable-text">Can we make for all of these</div>
            <span class="meta">7:23 PM</span>
          </div>
        </section>
      </div>
    `;
    await page.route("https://web.whatsapp.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: fixture })
    );
    await page.goto("https://web.whatsapp.com/fixture");
    await setupPage(page);

    const result = await page.evaluate(() => {
      const first = document.getElementById("preview-domain").firstChild;
      const last = document.getElementById("image-caption").firstChild;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const selectionText = selection.toString();
      document.getElementById("main").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );

      let captured;
      window.__tldrMsg(
        { type: "capture-selection", selectionText },
        null,
        (value) => (captured = value)
      );
      const nativeSelectionAfterCapture = selection.toString();

      // WhatsApp can replace its virtualized rows while previews and timestamps
      // hydrate. Recover the target beneath its exact serialized message id;
      // another message with the same caption must not steal the attribution.
      const main = document.getElementById("main");
      main.replaceWith(main.cloneNode(true));
      document.getElementById("preview-domain").textContent = "github.example";
      document.querySelector(".meta").textContent = "4:05 PM";
      document.getElementById("image-caption").classList.remove("selectable-text");
      document.getElementById("main").id = "main-next";
      document.getElementById("main-next").insertAdjacentHTML(
        "beforeend",
        '<div role="row" data-id="false_fixture_duplicate"><div class="selectable-text">Can we make for all of these</div></div>'
      );
      const target = "Can we make for all of these";
      const start = captured.text.indexOf(target);
      let highlighted;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (highlighted = value)
      );
      const focus =
        [...(CSS.highlights.get("tldr-attrib") || [])][0]?.toString() || "";
      document
        .getElementById("image-caption")
        .closest('[role="row"]')
        .setAttribute("data-id", "false_fixture_reused_for_other_chat");
      let reusedMessage;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (reusedMessage = value)
      );
      document
        .getElementById("image-caption")
        .closest('[role="row"]')
        .setAttribute("data-id", "true_fixture_message_2");
      document.getElementById("image-caption").textContent = "Changed target";
      let changedTarget;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (changedTarget = value)
      );
      return {
        captured,
        nativeSelectionAfterCapture,
        highlighted,
        focus,
        reusedMessage,
        changedTarget,
      };
    });

    const good =
      !result.captured?.error &&
      result.captured?.text.includes("github.com") &&
      result.captured?.text.includes("Can we make for all of these") &&
      result.captured?.text.includes("4:04 PM") &&
      !result.captured?.text.includes("Reply") &&
      !result.captured?.text.includes("7:23 PM") &&
      result.nativeSelectionAfterCapture === "" &&
      result.highlighted?.ok &&
      result.focus === "Can we make for all of these" &&
      result.reusedMessage?.ok === false &&
      result.changedTarget?.ok === false;
    console.log("\n### WhatsApp-style selectable-message fixture");
    console.log(
      `  [selectable override + unrelated mutation + highlight] ${good ? "PASS" : "FAIL"}` +
        ` — error=${result.captured?.error || "none"}, focus="${result.focus}"`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### WhatsApp-style selectable-message fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// SSR articles can hydrate or update media/lead content while an attributed
// paragraph later in the same selection remains unchanged. Restore only the
// clicked span beneath the unique semantic article instead of requiring every
// selected node to remain byte-identical.
{
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <main id="site-root">
        <article>
          <h1>FLUX 3: Real-World Visual Intelligence</h1>
          <p id="article-lead">FLUX 3 jointly learns from images, videos, and audio within one unified architecture.</p>
          <p id="article-target">Early results suggest this is the right path for real-world visual intelligence. Server-rendered footnote.</p>
        </article>
        <aside>Early results suggest this is the right path for real-world visual intelligence.</aside>
      </main>
    `);
    await setupPage(page);
    const result = await page.evaluate(() => {
      const lead = document.getElementById("article-lead").firstChild;
      const tail = document.getElementById("article-target").firstChild;
      const range = document.createRange();
      range.setStart(lead, 0);
      range.setEnd(tail, tail.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const selectionText = selection.toString();
      document.querySelector("article").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );
      let captured;
      window.__tldrMsg(
        { type: "capture-selection", selectionText },
        null,
        (value) => (captured = value)
      );

      const article = document.querySelector("article");
      const hydrated = article.cloneNode(true);
      hydrated.querySelector("#article-lead").textContent =
        "The lead changed after a client-side media block hydrated.";
      hydrated.querySelector("#article-target").firstChild.data =
        "Early results suggest this is the right path for real-world visual intelligence. Hydrated client footnote.";
      article.replaceWith(hydrated);

      const target =
        "Early results suggest this is the right path for real-world visual intelligence.";
      const start = captured.text.indexOf(target);
      let highlighted;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (highlighted = value)
      );
      const focus =
        [...(CSS.highlights.get("tldr-attrib") || [])][0]?.toString() || "";
      const duplicate = document.querySelector("article").cloneNode(true);
      duplicate.id = "duplicate-article";
      document.querySelector("article").after(duplicate);
      let duplicateArticle;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (duplicateArticle = value)
      );
      duplicate.remove();
      location.hash = "/different-source";
      let routeChanged;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (routeChanged = value)
      );
      location.hash = "";
      document.getElementById("article-target").firstChild.data =
        "Early output suggests this is the right path for real-world visual intelligence. Hydrated client footnote.";
      let changedTarget;
      window.__tldrMsg(
        { type: "highlight", start, end: start + target.length },
        null,
        (value) => (changedTarget = value)
      );
      return {
        captured,
        highlighted,
        focus,
        duplicateArticle,
        routeChanged,
        changedTarget,
      };
    });
    const good =
      !result.captured?.error &&
      result.highlighted?.ok &&
      result.duplicateArticle?.ok === false &&
      result.routeChanged?.ok === false &&
      result.changedTarget?.ok === false &&
      result.focus ===
        "Early results suggest this is the right path for real-world visual intelligence.";
    console.log("\n### Dynamic SSR article fixture");
    console.log(
      `  [unrelated hydration + semantic-span restore] ${good ? "PASS" : "FAIL"}` +
        ` — focus="${result.focus}"`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Dynamic SSR article fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// A stable semantic scope must be enough to recover exact attribution spans
// when hydration changes only the text-node topology. The canonical selection
// keeps its original synthetic newline even when two live blocks later become
// one inline wrapper.
{
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<main><article><h1>Resilient text topology</h1>' +
        '<p id="topology-target">Text topology stays anchored through split and merge.</p>' +
        '<p id="separator-a">Block separator</p>' +
        '<p id="separator-b">changes remain attributable.</p>' +
        "</article></main>"
    );
    await setupPage(page);
    const result = await page.evaluate(() => {
      const send = (message) => {
        let response;
        window.__tldrMsg(message, null, (value) => (response = value));
        return response;
      };
      const highlightedText = () =>
        [...(CSS.highlights.get("tldr-attrib") || [])]
          .map((range) => range.toString())
          .join("");
      const topologyTarget =
        "Text topology stays anchored through split and merge.";
      const separatorTarget =
        "Block separator\nchanges remain attributable.";
      const first = document.getElementById("topology-target").firstChild;
      const last = document.getElementById("separator-b").firstChild;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document
        .querySelector("article")
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      const captured = send({
        type: "capture-selection",
        selectionText: selection.toString(),
      });

      const topologyStart = captured.text.indexOf(topologyTarget);
      const separatorStart = captured.text.indexOf(separatorTarget);
      const topology = document.getElementById("topology-target");
      topology.innerHTML =
        'Text topology stays <span>anchored</span> through <em>split and merge.</em>';
      const split = send({
        type: "highlight",
        start: topologyStart,
        end: topologyStart + topologyTarget.length,
      });
      const splitFocus = highlightedText();

      topology.textContent = topologyTarget;
      const merged = send({
        type: "highlight",
        start: topologyStart,
        end: topologyStart + topologyTarget.length,
      });
      const mergedFocus = highlightedText();

      const article = document.querySelector("article");
      const rerendered = article.cloneNode(true);
      rerendered.querySelector("#topology-target").textContent =
        "Unrelated content changed during hydration.";
      article.replaceWith(rerendered);
      const blockWhitespace = send({
        type: "highlight",
        start: separatorStart,
        end: separatorStart + separatorTarget.length,
      });
      const blockWhitespaceFocus = highlightedText();
      document.getElementById("topology-target").textContent = topologyTarget;

      const separatorA = document.getElementById("separator-a");
      const combined = document.createElement("div");
      combined.id = "separator-combined";
      combined.innerHTML =
        "<span>Block separator </span><strong>changes remain attributable.</strong>";
      separatorA.replaceWith(combined);
      document.getElementById("separator-b").remove();
      const wrapperChanged = send({
        type: "highlight",
        start: separatorStart,
        end: separatorStart + separatorTarget.length,
      });
      const wrapperFocus = highlightedText();

      return {
        captured,
        topologyStart,
        separatorStart,
        split,
        splitFocus,
        merged,
        mergedFocus,
        blockWhitespace,
        blockWhitespaceFocus,
        wrapperChanged,
        wrapperFocus,
      };
    });
    const good =
      !result.captured?.error &&
      result.topologyStart >= 0 &&
      result.separatorStart >= 0 &&
      result.split?.ok &&
      result.splitFocus ===
        "Text topology stays anchored through split and merge." &&
      result.merged?.ok &&
      result.mergedFocus ===
        "Text topology stays anchored through split and merge." &&
      result.blockWhitespace?.ok &&
      result.blockWhitespaceFocus.replace(/\s+/g, "") ===
        "Blockseparatorchangesremainattributable." &&
      result.wrapperChanged?.ok &&
      norm(result.wrapperFocus) ===
        norm("Block separator changes remain attributable.");
    console.log("\n### Resilient text-topology fixture");
    console.log(
      `  [split + merge + block-wrapper recovery] ${good ? "PASS" : "FAIL"}` +
        ` — split="${result.splitFocus}", merged="${result.mergedFocus}", block="${result.blockWhitespaceFocus}", wrapper="${result.wrapperFocus}"`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Resilient text-topology fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// An occurrence ordinal is only a capture-time hint: when repeated text moves
// within one semantic article, its quote context must follow the intended
// paragraph. If two live candidates have identical quote context, fail closed.
{
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<main><article><h1>Repeated attribution context</h1>' +
        '<p data-case="alpha">Alpha lead — <span data-target>the shared citation belongs here</span> — alpha tail.</p>' +
        '<p data-case="beta">Beta lead — <span data-target>the shared citation belongs here</span> — beta tail.</p>' +
        "</article></main>"
    );
    await setupPage(page);
    const result = await page.evaluate(() => {
      const send = (message) => {
        let response;
        window.__tldrMsg(message, null, (value) => (response = value));
        return response;
      };
      const article = document.querySelector("article");
      const source = article.querySelector(
        '[data-case="beta"] [data-target]'
      ).firstChild;
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      article.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      const captured = send({
        type: "capture-selection",
        selectionText: selection.toString(),
      });
      const target = "the shared citation belongs here";
      const start = captured.text.lastIndexOf(target);

      article.innerHTML =
        '<h1>Repeated attribution context</h1>' +
        '<p data-case="beta">Beta lead — <span data-target>the shared citation belongs here</span> — beta tail.</p>' +
        '<p data-case="alpha">Alpha lead — <span data-target>the shared citation belongs here</span> — alpha tail.</p>';
      const reordered = send({
        type: "highlight",
        start,
        end: start + target.length,
      });
      const reorderedRange = [
        ...(CSS.highlights.get("tldr-attrib") || []),
      ][0];
      const reorderedCase =
        reorderedRange?.startContainer?.parentElement
          ?.closest("[data-case]")
          ?.getAttribute("data-case") || "";
      const reorderedFocus = reorderedRange?.toString() || "";

      send({ type: "clear-highlight" });
      article.innerHTML =
        '<h1>Repeated attribution context</h1>' +
        '<p data-case="ambiguous-one">Beta lead — <span data-target>the shared citation belongs here</span> — beta tail.</p>' +
        '<p data-case="ambiguous-two">Beta lead — <span data-target>the shared citation belongs here</span> — beta tail.</p>' +
        '<p data-case="alpha">Alpha lead — <span data-target>the shared citation belongs here</span> — alpha tail.</p>';
      const ambiguous = send({
        type: "highlight",
        start,
        end: start + target.length,
      });
      const ambiguousRanges = [
        ...(CSS.highlights.get("tldr-attrib") || []),
      ].length;

      return {
        captured,
        start,
        reordered,
        reorderedCase,
        reorderedFocus,
        ambiguous,
        ambiguousRanges,
      };
    });
    const good =
      !result.captured?.error &&
      result.start >= 0 &&
      result.reordered?.ok &&
      result.reorderedCase === "beta" &&
      result.reorderedFocus === "the shared citation belongs here" &&
      result.ambiguous?.ok === false &&
      result.ambiguousRanges === 0;
    console.log("\n### Repeated in-scope attribution fixture");
    console.log(
      `  [context-preserving reorder + ambiguity rejection] ${good ? "PASS" : "FAIL"}` +
        ` — case=${result.reorderedCase}, ambiguousOk=${result.ambiguous?.ok}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Repeated in-scope attribution fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// A generic element ID is only a scope hint. If hydration duplicates that ID,
// resolve against the page and require quote context instead of trusting the
// first invalid-ID match.
{
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<main><div id="generic-source" data-case="original">' +
        "<span>Original lead — </span><b>shared generic quote</b><span> — original tail.</span>" +
        "</div></main>"
    );
    await setupPage(page);
    const result = await page.evaluate(() => {
      const send = (message) => {
        let response;
        window.__tldrMsg(message, null, (value) => (response = value));
        return response;
      };
      const source = document.querySelector("#generic-source b").firstChild;
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      source.parentElement.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );
      const captured = send({
        type: "capture-selection",
        selectionText: selection.toString(),
      });

      document.getElementById("generic-source").outerHTML =
        '<div id="generic-source" data-case="wrong"><span>Wrong lead — </span><b>shared generic quote</b><span> — wrong tail.</span></div>' +
        '<div id="generic-source" data-case="right"><span>Original lead — </span><b>shared generic quote</b><span> — original tail.</span></div>';
      const response = send({
        type: "highlight",
        start: 0,
        end: captured.text.length,
      });
      const highlighted = [
        ...(CSS.highlights.get("tldr-attrib") || []),
      ][0];
      return {
        captured,
        response,
        focus: highlighted?.toString() || "",
        sourceCase:
          highlighted?.startContainer?.parentElement
            ?.closest("[data-case]")
            ?.getAttribute("data-case") || "",
      };
    });
    const good =
      result.captured?.text === "shared generic quote" &&
      result.response?.ok &&
      result.focus === "shared generic quote" &&
      result.sourceCase === "right";
    console.log("\n### Duplicate generic-ID scope fixture");
    console.log(
      `  [ID hint + body context fallback] ${good ? "PASS" : "FAIL"}` +
        ` — case=${result.sourceCase}, focus="${result.focus}"`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Duplicate generic-ID scope fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// If the originally attributed occurrence changes, an exact duplicate that
// already existed elsewhere in the same semantic scope must not steal the
// citation. Context and occurrence metadata can disambiguate a rerender, but
// cannot turn changed source content into a different source occurrence.
{
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<main><article><h1>Changed target with surviving duplicate</h1>' +
        '<p data-case="survivor">Alpha lead — the shared citation belongs here — alpha tail.</p>' +
        '<p data-case="original">Beta lead — the shared citation belongs here — beta tail.</p>' +
        "</article></main>"
    );
    await setupPage(page);
    const result = await page.evaluate(() => {
      const send = (message) => {
        let response;
        window.__tldrMsg(message, null, (value) => (response = value));
        return response;
      };
      const article = document.querySelector("article");
      const first = article.querySelector('[data-case="survivor"]').firstChild;
      const original = article.querySelector('[data-case="original"]').firstChild;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(original, original.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      article.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      const captured = send({
        type: "capture-selection",
        selectionText: selection.toString(),
      });
      const target = "the shared citation belongs here";
      const start = captured.text.lastIndexOf(target);

      original.data =
        "Beta lead — the changed citation belongs here — beta tail.";
      send({ type: "clear-highlight" });
      const response = send({
        type: "highlight",
        start,
        end: start + target.length,
      });
      const highlighted = [
        ...(CSS.highlights.get("tldr-attrib") || []),
      ];
      return {
        captured,
        start,
        response,
        ranges: highlighted.length,
        highlightedCase:
          highlighted[0]?.startContainer?.parentElement
            ?.closest("[data-case]")
            ?.getAttribute("data-case") || "",
      };
    });
    const good =
      !result.captured?.error &&
      result.start >= 0 &&
      result.response?.ok === false &&
      result.ranges === 0 &&
      result.highlightedCase === "";
    console.log("\n### Changed target with surviving duplicate fixture");
    console.log(
      `  [no fallback jump to unchanged duplicate] ${good ? "PASS" : "FAIL"}` +
        ` — ok=${result.response?.ok}, ranges=${result.ranges}, case=${result.highlightedCase || "none"}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Changed target with surviving duplicate fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Quote recovery is case- and code-unit-exact. ZWJ/ZWNJ participate in emoji
// and Indic shaping, so removing one must be treated as a target mutation
// rather than as ignorable formatting.
{
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<article><h1>Joiner exactness</h1>' +
        '<p id="joiner-target">Family 👩‍💻 remains joined.</p></article>'
    );
    await setupPage(page);
    const result = await page.evaluate(() => {
      const send = (message) => {
        let response;
        window.__tldrMsg(message, null, (value) => (response = value));
        return response;
      };
      const source = document.getElementById("joiner-target").firstChild;
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      source.parentElement.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );
      const captured = send({
        type: "capture-selection",
        selectionText: selection.toString(),
      });

      source.data = "Family 👩💻 remains joined.";
      send({ type: "clear-highlight" });
      const response = send({
        type: "highlight",
        start: 0,
        end: captured.text.length,
      });
      return {
        captured,
        response,
        ranges: [...(CSS.highlights.get("tldr-attrib") || [])].length,
      };
    });
    const good =
      result.captured?.text === "Family 👩‍💻 remains joined." &&
      result.response?.ok === false &&
      result.ranges === 0;
    console.log("\n### Joiner-exact quote fixture");
    console.log(
      `  [ZWJ mutation rejection] ${good ? "PASS" : "FAIL"}` +
        ` — ok=${result.response?.ok}, ranges=${result.ranges}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Joiner-exact quote fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// A React update can reuse the same connected Text node and alter content
// outside the clicked attribution. Validate only the target characters, while
// continuing to reject any mutation inside the target itself.
{
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<article><h1>Span-local mutation safety</h1>' +
        '<p id="span-local">Stable clicked phrase remains exact. Server-rendered suffix.</p>' +
        "</article>"
    );
    await setupPage(page);
    const result = await page.evaluate(() => {
      const send = (message) => {
        let response;
        window.__tldrMsg(message, null, (value) => (response = value));
        return response;
      };
      const source = document.getElementById("span-local").firstChild;
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      source.parentElement.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );
      const captured = send({
        type: "capture-selection",
        selectionText: selection.toString(),
      });
      const target = "Stable clicked phrase remains exact.";
      const start = captured.text.indexOf(target);

      source.data =
        "Stable clicked phrase remains exact. Hydrated client suffix.";
      const suffixChanged = send({
        type: "highlight",
        start,
        end: start + target.length,
      });
      const suffixFocus =
        [...(CSS.highlights.get("tldr-attrib") || [])][0]?.toString() || "";

      send({ type: "clear-highlight" });
      source.data =
        "Altered clicked phrase remains exact. Hydrated client suffix.";
      const targetChanged = send({
        type: "highlight",
        start,
        end: start + target.length,
      });
      const targetChangedRanges = [
        ...(CSS.highlights.get("tldr-attrib") || []),
      ].length;

      return {
        captured,
        start,
        suffixChanged,
        suffixFocus,
        targetChanged,
        targetChangedRanges,
      };
    });
    const good =
      !result.captured?.error &&
      result.start >= 0 &&
      result.suffixChanged?.ok &&
      result.suffixFocus === "Stable clicked phrase remains exact." &&
      result.targetChanged?.ok === false &&
      result.targetChangedRanges === 0;
    console.log("\n### Span-local same-node mutation fixture");
    console.log(
      `  [unrelated suffix accepted + target mutation rejected] ${good ? "PASS" : "FAIL"}` +
        ` — focus="${result.suffixFocus}", changedOk=${result.targetChanged?.ok}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Span-local same-node mutation fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Chrome's context-menu selectionText can flatten or omit invisible formatting
// characters differently from the exact DOM Range. A successful eager snapshot
// must remain authoritative instead of producing a false "page changed" error.
{
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<p id="source">Selected\u200b text from the page.</p><p id="other">Other text.</p>'
    );
    await setupPage(page);
    const result = await page.evaluate(() => {
      const source = document.getElementById("source");
      const node = source.firstChild;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      source.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

      let captured;
      window.__tldrMsg(
        {
          type: "capture-selection",
          // Simulate Chrome flattening the invisible character out.
          selectionText: "Selected text from the page.",
        },
        null,
        (value) => (captured = value)
      );
      const nativeSelectionAfterCapture = selection.toString();

      let highlighted;
      const start = captured.text.indexOf("text");
      window.__tldrMsg(
        { type: "highlight", start, end: start + 4 },
        null,
        (value) => (highlighted = value)
      );
      const focus = [...(CSS.highlights.get("tldr-attrib") || [])][0];
      return {
        captured,
        nativeSelectionAfterCapture,
        highlighted,
        focus: focus?.toString() || "",
      };
    });
    const good =
      !result.captured?.error &&
      result.captured?.text.includes("Selected") &&
      result.nativeSelectionAfterCapture === "" &&
      result.highlighted?.ok &&
      result.focus === "text";
    console.log("\n### Flattened selection hint fixture");
    console.log(
      `  [exact Range beats normalized hint + clears native selection] ${good ? "PASS" : "FAIL"}` +
        ` — selected=${result.nativeSelectionAfterCapture.length}, focus="${result.focus}"`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Flattened selection hint fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Substack-style header-to-body selection with CSS-transformed date and
// unselectable reaction controls. This exercises the late-injection fallback.
{
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <style>
        .date { text-transform: uppercase; }
        .actions { user-select: none; }
      </style>
      <article aria-hidden="true">
        <h1 id="title">Substack Capture</h1>
        <div class="date">Jul 06, 2026</div>
        <div class="actions"><span>1,985</span> <span>182</span> <button>Share</button></div>
        <p id="body">Article body starts here and continues.</p>
      </article>
    `);

    // Simulate an already-open tab: the user selected from the title into the
    // body, but content.js was injected only after the native selection had
    // collapsed. The context-menu API still supplies the rendered text hint.
    await page.evaluate(() => {
      const range = document.createRange();
      range.setStart(document.getElementById("title").firstChild, 0);
      const tail = document.getElementById("body").firstChild;
      range.setEnd(tail, tail.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      selection.removeAllRanges();
    });
    await setupPage(page);

    const result = await page.evaluate(() => {
      // A collapsed caret is not the stale blue selection the feature is meant
      // to clear, so late-injection recovery must leave it alone.
      const selection = window.getSelection();
      const caret = document.createRange();
      caret.setStart(document.getElementById("body").firstChild, 0);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);

      let captured;
      window.__tldrMsg(
        {
          type: "capture-selection",
          selectionText:
            "Substack Capture JUL 06, 2026 Article body starts here and continues.",
        },
        null,
        (value) => (captured = value)
      );
      let highlighted;
      const start = captured.text.indexOf("Article body");
      window.__tldrMsg(
        { type: "highlight", start, end: start + "Article body".length },
        null,
        (value) => (highlighted = value)
      );
      const focus = [...(CSS.highlights.get("tldr-attrib") || [])][0];
      return {
        captured,
        caretPreserved: selection.rangeCount === 1 && selection.isCollapsed,
        highlighted,
        focus: focus?.toString() || "",
      };
    });
    const good =
      !result.captured?.error &&
      result.captured?.text.includes("Jul 06, 2026") &&
      !result.captured?.text.includes("1,985") &&
      !result.captured?.text.includes("Share") &&
      result.caretPreserved &&
      result.highlighted?.ok &&
      result.focus === "Article body";
    console.log("\n### Substack late-injection fixture");
    console.log(
      `  [header→body hint remap] ${good ? "PASS" : "FAIL"}` +
        ` — caret=${result.caretPreserved}, focus="${result.focus}"`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Substack late-injection fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// X Article fixture based on the current long-form selectors and DraftJS block
// shape. Article bodies are sign-in-gated in a clean browser, so this keeps a
// deterministic regression for the full body rather than merely its preview.
{
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <div id="react-root">
        <main>
          <div data-testid="twitterArticleReadView">
            <h1 data-testid="twitter-article-title"><span>Reading an order book</span></h1>
            <div data-testid="longformRichTextComponent">
              <div data-contents="true">
                <div data-block="true"><div class="public-DraftStyleDefault-block"><span data-text="true">An order book records resting bids and asks.</span></div></div>
                <div data-block="true"><div class="public-DraftStyleDefault-block"><span data-text="true">Depth changes as participants add and cancel liquidity.</span></div></div>
                <div data-block="true" class="second"><div class="public-DraftStyleDefault-block"><span data-text="true">The live order book can therefore move before a trade prints.</span></div></div>
              </div>
            </div>
          </div>
        </main>
      </div>
    `);
    await setupPage(page);
    const captured = await page.evaluate(() => {
      const title = document.querySelector("[data-testid=twitter-article-title] span").firstChild;
      const tail = document.querySelector(".second [data-text=true]").firstChild;
      const range = document.createRange();
      range.setStart(title, 0);
      range.setEnd(tail, tail.data.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector(".second").dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );
      let response;
      window.__tldrMsg(
        { type: "capture-selection", selectionText: selection.toString() },
        null,
        (value) => (response = value)
      );
      return response;
    });
    const sourceStart = captured.text.lastIndexOf("order book");
    const result = await page.evaluate(
      ({ start }) => {
        const view = document.querySelector("[data-testid=twitterArticleReadView]");
        view.replaceWith(view.cloneNode(true));
        let response;
        window.__tldrMsg(
          {
            type: "highlight",
            start,
            end: start + 10,
          },
          null,
          (value) => (response = value)
        );
        const range = [...CSS.highlights.get("tldr-attrib")][0];
        return {
          response,
          text: range?.toString(),
          second: !!range?.startContainer?.parentElement?.closest(".second"),
        };
      },
      { start: sourceStart }
    );
    const good =
      captured.text.split("\n").length >= 4 &&
      result.response?.ok &&
      result.text === "order book" &&
      result.second;
    console.log("\n### X Article long-form fixture");
    console.log(
      `  [DraftJS blocks + rerender + repeated text] ${good ? "PASS" : "FAIL"}` +
        ` — focus="${result.text}", second=${result.second}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### X Article long-form fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Public X currently exposes stable post identity as data-tweet-id. A React
// rerender plus feed reorder must not rebind a short duplicate to another post.
{
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<main><ol id="timeline">' +
        '<li><article data-tweet-id="111" itemscope itemtype="https://schema.org/SocialMediaPosting"><span>Fable 5</span></article></li>' +
        '<li><article data-tweet-id="222" itemscope itemtype="https://schema.org/SocialMediaPosting"><span>Fable 5</span></article></li>' +
        "</ol></main>"
    );
    await setupPage(page);
    const result = await page.evaluate(() => {
      const source = document.querySelector('[data-tweet-id="111"]');
      const node = source.querySelector("span").firstChild;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      source.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));

      let captured;
      window.__tldrMsg(
        { type: "capture-selection", selectionText: selection.toString() },
        null,
        (value) => (captured = value)
      );

      const rerendered = source.closest("li").cloneNode(true);
      source.closest("li").remove();
      document.getElementById("timeline").append(rerendered);
      document.getElementById("timeline").insertAdjacentHTML(
        "afterbegin",
        '<li><article data-tweet-id="333" itemscope itemtype="https://schema.org/SocialMediaPosting"><span>Fable 5</span></article></li>'
      );

      let response;
      window.__tldrMsg(
        { type: "highlight", start: 0, end: "Fable 5".length },
        null,
        (value) => (response = value)
      );
      const highlighted = [...(CSS.highlights.get("tldr-attrib") || [])][0];
      return {
        captured,
        response,
        text: highlighted?.toString() || "",
        tweetId:
          highlighted?.startContainer?.parentElement
            ?.closest("article[data-tweet-id]")
            ?.getAttribute("data-tweet-id") || null,
      };
    });
    const good =
      result.captured?.text === "Fable 5" &&
      result.response?.ok &&
      result.text === "Fable 5" &&
      result.tweetId === "111";
    console.log("\n### X duplicate-post identity fixture");
    console.log(
      `  [rerender + reorder preserves data-tweet-id] ${good ? "PASS" : "FAIL"}` +
        ` — id=${result.tweetId}, focus="${result.text}"`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### X duplicate-post identity fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// React may reuse a connected Text node for different content. Connectivity
// alone is not enough evidence that saved source offsets still point at it.
{
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<article data-tweet-id="444"><span>Fable 5</span></article>'
    );
    await setupPage(page);
    const result = await page.evaluate(() => {
      const source = document.querySelector("span").firstChild;
      const range = document.createRange();
      range.selectNodeContents(source);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      source.parentElement.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true })
      );
      let captured;
      window.__tldrMsg(
        { type: "capture-selection", selectionText: selection.toString() },
        null,
        (value) => (captured = value)
      );

      source.data = "Wrong 55";
      let response;
      window.__tldrMsg(
        { type: "highlight", start: 0, end: "Fable 5".length },
        null,
        (value) => (response = value)
      );
      const highlighted = CSS.highlights.get("tldr-attrib");
      return {
        captured,
        response,
        count: highlighted ? [...highlighted].length : 0,
      };
    });
    const good =
      result.captured?.text === "Fable 5" &&
      result.response?.ok === false &&
      result.count === 0;
    console.log("\n### Connected-node mutation fixture");
    console.log(
      `  [changed source text is rejected] ${good ? "PASS" : "FAIL"}` +
        ` — ok=${result.response?.ok}, ranges=${result.count}`
    );
    recordDeterministic(good);
  } catch (error) {
    console.log(
      `\n### Connected-node mutation fixture\n  FAIL — ${String(error.message).split("\n")[0]}`
    );
    recordDeterministic(false);
  } finally {
    await page.close();
  }
}

// Public X post detail page. Target the post body itself (not navigation) and
// replace its rendered span before highlighting to exercise React rerenders.
{
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36",
  });
  const url = "https://x.com/NASA/status/2079303636895629808";
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(1800);
    await setupPage(page);
    const captured = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.data.includes("Crew-13")) break;
      }
      if (!node) return { error: "post body not found" };
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      node.parentElement.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
      let response;
      window.__tldrMsg(
        { type: "capture-selection", selectionText: selection.toString() },
        null,
        (value) => (response = value)
      );
      node.parentElement.replaceWith(node.parentElement.cloneNode(true));
      return response;
    });
    const start = captured.text?.indexOf("Crew-13") ?? -1;
    const result =
      start >= 0
        ? await highlight(page, start, start + "Crew-13".length)
        : { resp: null, ranges: [] };
    const good =
      !captured.error &&
      result.resp?.ok &&
      result.ranges.join("") === "Crew-13";
    console.log("\n### X post detail page");
    console.log(
      `  [post capture + React rerender + highlight] ${good ? "PASS" : "FAIL"}` +
        ` — "${result.ranges.join("")}"`
    );
    good ? totalPass++ : totalFail++;
  } catch (error) {
    console.log(
      `\n### X post detail page\n  LOAD FAILED — ${String(error.message).split("\n")[0]}`
    );
    totalFail++;
  } finally {
    await page.close();
  }
}

for (const url of SITES) {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36",
  });
  const label = url.replace(/^https?:\/\//, "");
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForTimeout(1200);
    await setupPage(page);

    // Test 1: single-text-node selection extracts (the x.com regression).
    const single = await captureRegion(page, "single");
    const singleOk = single && !single.error && single.text && single.text.length > 5;
    console.log(
      `\n### ${label}`
    );
    console.log(
      `  [single-node capture] ${singleOk ? "PASS" : "FAIL"}` +
        (singleOk ? ` — "${single.text.slice(0, 45)}…"` : ` — ${JSON.stringify(single)}`)
    );
    singleOk ? totalPass++ : totalFail++;

    // Test 2: multi-block capture + highlight every attribution (incl. headings)
    const region = await captureRegion(page, "region");
    if (!region || region.error || !region.text) {
      console.log(`  [region capture] FAIL — ${JSON.stringify(region)}`);
      totalFail++;
    } else {
      const attribs = stubAttribs(region.text);
      let ok = 0,
        bad = 0;
      const failures = [];
      for (const a of attribs) {
        const { resp, ranges } = await highlight(page, a.sourceStart, a.sourceEnd);
        const hlText = ranges.join(" ");
        const want = norm(region.text.slice(a.sourceStart, a.sourceEnd)).split(" ")[0] || "";
        const good = resp && resp.ok && hlText.length > 0 && norm(hlText).includes(want);
        if (good) ok++;
        else {
          bad++;
          failures.push(`"${a.sentence.slice(0, 30)}" -> ok=${resp && resp.ok} hl="${hlText.slice(0, 30)}"`);
        }
      }
      console.log(
        `  [region capture] PASS — ${region.text.split("\n").filter(Boolean).length} blocks`
      );
      console.log(
        `  [attribution highlights] ${ok}/${ok + bad} resolved${bad ? " — misses: " + failures.join(" | ") : ""}`
      );
      bad === 0 ? totalPass++ : totalFail++;
    }
  } catch (e) {
    console.log(`\n### ${label}\n  LOAD FAILED — ${String(e.message).split("\n")[0]}`);
    totalFail++;
  } finally {
    await page.close();
  }
}

await browser.close();
console.log(`\n=========================\nsuites passed: ${totalPass}, failed: ${totalFail}`);
if (deterministicFail > 0) process.exitCode = 1;
