// Isolated test of the YouTube transcript logic that lives in content.js: the
// transcript-panel request it synthesizes, the view-model rows it accepts, the
// transcript text + cue table it builds from them, and the cue an attributed
// character range seeks to.
//
// content.js itself is evaluated here and the helpers under test come from its
// `__tldrTestHooks` export, so these assertions can never drift from the code
// that runs on a watch page.

const assert = require("assert");
const { readFileSync } = require("fs");
const { join } = require("path");
const test = require("node:test");
const vm = require("vm");

const source = readFileSync(join(__dirname, "..", "content.js"), "utf8");

function loadContentScript() {
  const sandbox = {
    CSS: { highlights: new Map() },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    URL,
    URLSearchParams,
    btoa,
    chrome: { runtime: { onMessage: { addListener() {} } } },
    console: { log() {}, warn() {}, error() {} },
    document: {
      addEventListener() {},
      body: null,
      documentElement: null,
      createRange: () => ({ setStart() {}, setEnd() {} }),
    },
    location: {
      hash: "",
      hostname: "www.youtube.com",
      href: "https://www.youtube.com/watch?v=abc12345678",
      origin: "https://www.youtube.com",
      pathname: "/watch",
      search: "?v=abc12345678",
    },
    window: { getSelection: () => null, getComputedStyle: () => ({}) },
  };
  sandbox.__tldrTestHooks = {};
  vm.runInContext(source, vm.createContext(sandbox), {
    filename: "content.js",
  });
  return sandbox.__tldrTestHooks;
}

const hooks = loadContentScript();
for (const name of [
  "buildTranscriptFromSegments",
  "findCueForSpan",
  "hasCaptionTracks",
  "normalizedYouTubeSearch",
  "playerResponseFrom",
  "timestampToMs",
  "transcriptPanelParams",
  "transcriptSegmentsFrom",
]) {
  assert.strictEqual(
    typeof hooks[name],
    "function",
    `content.js exports ${name} to the test harness`
  );
}

const build = hooks.buildTranscriptFromSegments;
const cueFor = hooks.findCueForSpan;

// content.js is evaluated in a vm realm, so its arrays and objects have that
// realm's prototypes. Compare structure, not constructor identity.
const plain = (value) => JSON.parse(JSON.stringify(value));

const cue = (tStartMs, text) => ({ tStartMs, text });

// ---------------------------------------------------------------------------
// The transcript-panel request
// ---------------------------------------------------------------------------

test("the panel params are byte-identical to YouTube's own", () => {
  // Golden vector captured from a real watch page's transcript request.
  assert.strictEqual(
    hooks.transcriptPanelParams("ugvHCXCOmm4"),
    "qgkPCgt1Z3ZIQ1hDT21tNBgB"
  );
  assert.strictEqual(
    hooks.transcriptPanelParams("demo1234567"),
    "qgkPCgtkZW1vMTIzNDU2NxgB"
  );
  // The encoding is length-driven, not fixed to eleven characters.
  assert.strictEqual(hooks.transcriptPanelParams("abc"), "qgkHCgNhYmMYAQ==");
  // A video id that is not a video id never becomes a request.
  assert.strictEqual(hooks.transcriptPanelParams(""), null);
  assert.strictEqual(hooks.transcriptPanelParams(null), null);
  assert.strictEqual(hooks.transcriptPanelParams("has spaces"), null);
  assert.strictEqual(hooks.transcriptPanelParams("../../etc/passwd"), null);
  assert.strictEqual(hooks.transcriptPanelParams("x".repeat(65)), null);
});

test("the panel params decode back to the video id", () => {
  // Independent check of the hand-rolled protobuf: field 149 wrapping
  // field 1 = the ASCII video id, field 3 = 1.
  const bytes = Buffer.from(
    hooks.transcriptPanelParams("ugvHCXCOmm4"),
    "base64"
  );
  assert.deepStrictEqual([...bytes.subarray(0, 5)], [0xaa, 0x09, 15, 0x0a, 11]);
  assert.strictEqual(bytes.subarray(5, 16).toString("ascii"), "ugvHCXCOmm4");
  assert.deepStrictEqual([...bytes.subarray(16)], [0x18, 0x01]);
});

test("caption availability is read from the player response, not fetched", () => {
  const withCaptions = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=1",
            languageCode: "en",
          },
        ],
      },
    },
  };
  assert.strictEqual(hooks.hasCaptionTracks(withCaptions), true);
  assert.strictEqual(hooks.hasCaptionTracks({ captions: {} }), false);
  assert.strictEqual(
    hooks.hasCaptionTracks({
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
    }),
    false
  );
  // A renderer present but empty of usable tracks is still "no captions".
  assert.strictEqual(
    hooks.hasCaptionTracks({
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [{}] } },
    }),
    false
  );
  assert.strictEqual(hooks.hasCaptionTracks(null), false);
  assert.strictEqual(hooks.hasCaptionTracks(undefined), false);
});

// ---------------------------------------------------------------------------
// The transcript-panel response
// ---------------------------------------------------------------------------

test("displayed timestamps parse to milliseconds", () => {
  const ms = hooks.timestampToMs;
  assert.strictEqual(ms("0:00"), 0);
  assert.strictEqual(ms("0:03"), 3_000);
  assert.strictEqual(ms("0:59"), 59_000);
  assert.strictEqual(ms("1:00"), 60_000);
  assert.strictEqual(ms("12:34"), 754_000);
  assert.strictEqual(ms("1:02:03"), 3_723_000);
  assert.strictEqual(ms("1:02:45"), 3_765_000);
  assert.strictEqual(ms("10:00:00"), 36_000_000);
  assert.strictEqual(ms(" 4:20 "), 260_000);
  // Anything that is not a timestamp yields no cue rather than a wrong seek.
  assert.strictEqual(ms(""), null);
  assert.strictEqual(ms("42"), null);
  assert.strictEqual(ms("1:2:3:4"), null);
  assert.strictEqual(ms("1:75"), null);
  assert.strictEqual(ms("-1:00"), null);
  assert.strictEqual(ms("soon"), null);
  assert.strictEqual(ms(3_000), null);
  assert.strictEqual(ms(null), null);
});

// A realistic slice of the get_panel response: transcript rows nested in
// panel/timeline wrappers, interleaved with chapter headings that are a
// different view-model type and must not become speech.
const PANEL_RESPONSE = {
  responseContext: { visitorData: "ignored" },
  content: {
    sectionListRenderer: {
      contents: [
        {
          transcriptSegmentListRenderer: {
            initialSegments: [
              {
                macroMarkersPanelItemViewModel: {
                  timelineItemViewModel: {
                    transcriptSectionHeaderViewModel: {
                      headerText: "Introduction",
                      timestamp: "0:00",
                    },
                  },
                },
              },
              {
                macroMarkersPanelItemViewModel: {
                  timelineItemViewModel: {
                    transcriptSegmentViewModel: {
                      simpleText: "Welcome back to the show",
                      timestamp: "0:00",
                      timestampA11yLabel: "0 seconds",
                      timestampUtf16Length: 4,
                      textUtf16Length: 24,
                    },
                  },
                },
              },
              {
                macroMarkersPanelItemViewModel: {
                  timelineItemViewModel: {
                    transcriptSegmentViewModel: {
                      simpleText: "today we are\ntalking about kettles",
                      timestamp: "0:06",
                      timestampA11yLabel: "6 seconds",
                    },
                  },
                },
              },
              {
                macroMarkersPanelItemViewModel: {
                  timelineItemViewModel: {
                    transcriptSectionHeaderViewModel: {
                      headerText: "The physics",
                      timestamp: "0:12",
                    },
                  },
                },
              },
              {
                macroMarkersPanelItemViewModel: {
                  timelineItemViewModel: {
                    transcriptSegmentViewModel: {
                      simpleText: "water boils at one hundred degrees",
                      timestamp: "0:12",
                    },
                  },
                },
              },
              {
                macroMarkersPanelItemViewModel: {
                  timelineItemViewModel: {
                    transcriptSegmentViewModel: {
                      simpleText: "altitude lowers the boiling point",
                      timestamp: "1:02:45",
                    },
                  },
                },
              },
            ],
          },
        },
      ],
    },
  },
};

test("only transcript rows are taken, in the order they appear", () => {
  const segments = plain(hooks.transcriptSegmentsFrom(PANEL_RESPONSE));
  assert.deepStrictEqual(segments, [
    { text: "Welcome back to the show", tStartMs: 0 },
    { text: "today we are\ntalking about kettles", tStartMs: 6_000 },
    { text: "water boils at one hundred degrees", tStartMs: 12_000 },
    { text: "altitude lowers the boiling point", tStartMs: 3_765_000 },
  ]);
  // Chapter headings share the list and the wrappers, and are not speech.
  assert.ok(!segments.some((segment) => segment.text.includes("Introduction")));
  assert.ok(!segments.some((segment) => segment.text.includes("The physics")));
});

test("unusable transcript rows are skipped, not guessed at", () => {
  const segments = plain(
    hooks.transcriptSegmentsFrom({
      content: [
        { transcriptSegmentViewModel: { simpleText: "kept", timestamp: "0:01" } },
        { transcriptSegmentViewModel: { simpleText: "no timestamp" } },
        { transcriptSegmentViewModel: { timestamp: "0:02" } },
        { transcriptSegmentViewModel: { simpleText: "   ", timestamp: "0:03" } },
        { transcriptSegmentViewModel: { simpleText: 12, timestamp: "0:04" } },
        {
          transcriptSegmentViewModel: {
            simpleText: "bad timestamp",
            timestamp: "later",
          },
        },
        { transcriptSegmentViewModel: null },
        {
          transcriptSegmentViewModel: {
            simpleText: "also kept",
            timestamp: "0:09",
          },
        },
      ],
    })
  );
  assert.deepStrictEqual(segments, [
    { text: "kept", tStartMs: 1_000 },
    { text: "also kept", tStartMs: 9_000 },
  ]);
  // A response with no transcript at all yields nothing to summarise.
  assert.deepStrictEqual(plain(hooks.transcriptSegmentsFrom({})), []);
  assert.deepStrictEqual(plain(hooks.transcriptSegmentsFrom(null)), []);
  assert.deepStrictEqual(
    plain(hooks.transcriptSegmentsFrom({ error: { code: 400 } })),
    []
  );
});

// ---------------------------------------------------------------------------
// Transcript text and the cue table
// ---------------------------------------------------------------------------

test("cue offsets are UTF-16 indexes into the joined transcript", () => {
  const { text, cues, truncated } = build([
    cue(0, "Welcome back"),
    cue(2_000, "to the show"),
    cue(4_500, "everyone"),
  ]);
  assert.strictEqual(text, "Welcome back to the show everyone");
  assert.strictEqual(truncated, false);
  assert.deepStrictEqual(plain(cues), [
    { start: 0, end: 12, tStartMs: 0 },
    { start: 13, end: 24, tStartMs: 2_000 },
    { start: 25, end: 33, tStartMs: 4_500 },
  ]);
  // Every cue's slice is exactly the words spoken then, and the one character
  // between two cues is the separator, owned by neither.
  assert.strictEqual(text.slice(cues[1].start, cues[1].end), "to the show");
  assert.strictEqual(text.slice(cues[0].end, cues[1].start), " ");
});

test("a wrapped transcript row collapses into one cue", () => {
  const { text, cues } = build([
    cue(0, "The kettle sings\nloudly"),
    cue(3_000, "   and then   stops "),
  ]);
  assert.strictEqual(text, "The kettle sings loudly and then stops");
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(
    text.slice(cues[0].start, cues[0].end),
    "The kettle sings loudly"
  );
  assert.strictEqual(text.slice(cues[1].start, cues[1].end), "and then stops");
});

test("the panel response feeds the cue table end to end", () => {
  const { text, cues } = build(hooks.transcriptSegmentsFrom(PANEL_RESPONSE));
  assert.strictEqual(
    text,
    "Welcome back to the show today we are talking about kettles " +
      "water boils at one hundred degrees altitude lowers the boiling point"
  );
  const start = text.indexOf("altitude");
  assert.strictEqual(
    cueFor(cues, start, start + "altitude".length).tStartMs,
    3_765_000
  );
});

test("CJK and astral characters keep the cue table in UTF-16 units", () => {
  const { text, cues } = build([
    cue(0, "こんにちは世界"),
    cue(1_200, "graduation 🎓 day"),
    cue(2_400, "後半戦"),
  ]);
  // 🎓 is a surrogate pair: two UTF-16 code units, one code point.
  assert.strictEqual(cues[0].end - cues[0].start, 7);
  assert.strictEqual(cues[1].end - cues[1].start, "graduation 🎓 day".length);
  assert.strictEqual(cues[1].end - cues[1].start, 17);
  assert.strictEqual(Array.from("graduation 🎓 day").length, 16);
  assert.strictEqual(text.slice(cues[2].start, cues[2].end), "後半戦");
});

test("malformed segments are skipped, not counted", () => {
  const { text, cues } = build([
    cue(500, "   "),
    { text: "no start time" },
    { tStartMs: 900 },
    cue(-5, "negative"),
    cue("nonsense", "unparseable"),
    cue(1_000, "real speech"),
    null,
    cue(2_000, "more speech"),
  ]);
  assert.strictEqual(text, "real speech more speech");
  assert.deepStrictEqual(
    Array.from(cues, (entry) => entry.tStartMs),
    [1_000, 2_000]
  );
  assert.deepStrictEqual(plain(build(null)), {
    text: "",
    cues: [],
    truncated: false,
  });
  assert.deepStrictEqual(plain(build(undefined).cues), []);
});

test("a transcript longer than the source cap is truncated, never split", () => {
  const segments = [cue(0, "aaaa"), cue(1_000, "bbbb"), cue(2_000, "cccc")];
  const bounded = build(segments, { maxCharacters: 10 });
  // "aaaa bbbb" is 9; adding " cccc" would exceed 10, so the third cue is
  // dropped whole rather than cut in half.
  assert.strictEqual(bounded.text, "aaaa bbbb");
  assert.strictEqual(bounded.truncated, true);
  assert.strictEqual(bounded.cues.length, 2);
  assert.strictEqual(
    bounded.cues[bounded.cues.length - 1].end,
    bounded.text.length
  );

  const cueCapped = build(segments, { maxCues: 2 });
  assert.strictEqual(cueCapped.cues.length, 2);
  assert.strictEqual(cueCapped.truncated, true);
  assert.strictEqual(build(segments).truncated, false);
});

// ---------------------------------------------------------------------------
// Character range -> cue
// ---------------------------------------------------------------------------

const SPOKEN = build([
  cue(0, "Welcome back"),
  cue(2_000, "to the show"),
  cue(4_500, "everyone"),
]);

test("a range inside one cue resolves to that cue", () => {
  const start = SPOKEN.text.indexOf("the show");
  assert.strictEqual(
    cueFor(SPOKEN.cues, start, start + "the show".length).tStartMs,
    2_000
  );
  // Whole-cue and single-character ranges agree with it.
  assert.strictEqual(cueFor(SPOKEN.cues, 13, 24).tStartMs, 2_000);
  assert.strictEqual(cueFor(SPOKEN.cues, 23, 24).tStartMs, 2_000);
  assert.strictEqual(cueFor(SPOKEN.cues, 0, 1).tStartMs, 0);
});

test("a range spanning two cues seeks to the earlier one", () => {
  const start = SPOKEN.text.indexOf("back");
  const end = SPOKEN.text.indexOf("show") + 4;
  assert.strictEqual(cueFor(SPOKEN.cues, start, end).tStartMs, 0);
  // Spanning all three still starts at the beginning of the quote.
  assert.strictEqual(cueFor(SPOKEN.cues, 0, SPOKEN.text.length).tStartMs, 0);
  // Starting in the second cue and ending in the third takes the second.
  assert.strictEqual(cueFor(SPOKEN.cues, 20, 28).tStartMs, 2_000);
});

test("a range on a cue separator takes the nearer neighbour", () => {
  // [12, 13) is the single space between cue 0 and cue 1.
  assert.strictEqual(cueFor(SPOKEN.cues, 12, 13).tStartMs, 0);
  const gapped = [
    { start: 0, end: 4, tStartMs: 0 },
    { start: 40, end: 44, tStartMs: 9_000 },
  ];
  assert.strictEqual(cueFor(gapped, 5, 6).tStartMs, 0);
  assert.strictEqual(cueFor(gapped, 38, 39).tStartMs, 9_000);
});

test("a range outside the cue table has no timestamp and fails closed", () => {
  assert.strictEqual(cueFor(SPOKEN.cues, 10_000, 10_050), null);
  assert.strictEqual(
    cueFor(SPOKEN.cues, SPOKEN.text.length, SPOKEN.text.length + 5),
    null
  );
  const offset = [{ start: 10, end: 14, tStartMs: 7_000 }];
  assert.strictEqual(cueFor(offset, 0, 4), null);
  assert.strictEqual(cueFor(offset, 0, 11).tStartMs, 7_000);
  // Empty, collapsed, and unusable inputs never invent a cue.
  assert.strictEqual(cueFor([], 0, 5), null);
  assert.strictEqual(cueFor(null, 0, 5), null);
  assert.strictEqual(cueFor(SPOKEN.cues, 5, 5), null);
  assert.strictEqual(cueFor(SPOKEN.cues, 8, 3), null);
  assert.strictEqual(cueFor(SPOKEN.cues, NaN, 4), null);
});

test("every character of a built transcript maps back to its own cue", () => {
  const built = build([
    cue(0, "こんにちは"),
    cue(1_000, "graduation 🎓 day"),
    cue(2_000, "後半戦です"),
  ]);
  for (const entry of built.cues) {
    for (let index = entry.start; index < entry.end; index++) {
      assert.strictEqual(
        cueFor(built.cues, index, index + 1).tStartMs,
        entry.tStartMs,
        `offset ${index} belongs to the cue at ${entry.tStartMs}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Page reading and URL identity
// ---------------------------------------------------------------------------

test("the inline player response survives braces inside JSON strings", () => {
  const payload = {
    videoDetails: { videoId: "abc12345678", title: 'a } and a { in "quotes"' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=1",
            languageCode: "en",
          },
        ],
      },
    },
  };
  const script =
    'var meta = {"a":1};var ytInitialPlayerResponse = ' +
    JSON.stringify(payload) +
    ";var after = 2;";
  const parsed = hooks.playerResponseFrom(script);
  assert.strictEqual(parsed.videoDetails.videoId, "abc12345678");
  assert.strictEqual(hooks.hasCaptionTracks(parsed), true);
  // A truncated or absent assignment yields nothing rather than a guess.
  assert.strictEqual(hooks.playerResponseFrom("var x = 1;"), null);
  assert.strictEqual(
    hooks.playerResponseFrom('ytInitialPlayerResponse = {"a": 1'),
    null
  );
  assert.strictEqual(hooks.playerResponseFrom(""), null);
});

test("content.js drops YouTube time parameters from its route key", () => {
  const normalize = hooks.normalizedYouTubeSearch;
  assert.strictEqual(normalize("?v=abc123&t=612"), "?v=abc123");
  assert.strictEqual(
    normalize("?v=abc123&start=90&time_continue=5"),
    "?v=abc123"
  );
  assert.strictEqual(normalize("?t=42"), "");
  // The video itself, playlists, and indexes are identity and stay.
  assert.strictEqual(normalize("?v=abc123"), "?v=abc123");
  assert.strictEqual(
    normalize("?v=abc123&list=PL9&index=4&t=30"),
    "?v=abc123&list=PL9&index=4"
  );
  assert.strictEqual(normalize(""), "");
});
