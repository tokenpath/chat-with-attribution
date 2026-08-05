const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

// chat-cache.ts owns the one URL-identity policy the panel uses for both the
// page-chat key and its navigation guard, so it compiles and runs standalone.
const sourcePath = path.resolve(__dirname, "../src/sidepanel/chat-cache.ts");
const compileDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "tldr-controller-urls-test-")
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
  documentIdentityUrl,
  pageChatKey,
  sameDocumentUrl,
} = require(path.join(compileDirectory, "chat-cache.js"));

const ARTICLE = "https://example.com/article";

test("a plain #section fragment is scroll position, not page identity", () => {
  assert.strictEqual(
    documentIdentityUrl(`${ARTICLE}#introduction`),
    `${ARTICLE}`
  );
  assert.ok(sameDocumentUrl(`${ARTICLE}#introduction`, `${ARTICLE}#summary`));
  assert.ok(sameDocumentUrl(`${ARTICLE}#introduction`, ARTICLE));
});

test("routing hashes ARE page identity, matching content.js currentRouteKey", () => {
  // Conventional hash routers ("#/…", "#!…") use the hash as the route; two
  // routes are two documents, so each keeps its own chat and the content
  // script's route key agrees.
  assert.ok(!sameDocumentUrl(`${ARTICLE}#/inbox`, `${ARTICLE}#/archive`));
  assert.ok(sameDocumentUrl(`${ARTICLE}#/inbox`, `${ARTICLE}#/inbox`));
  assert.ok(!sameDocumentUrl(`${ARTICLE}#!settings`, `${ARTICLE}#!profile`));
  // Gmail's hashes are routes even without the #!/#/ convention.
  const gmail = "https://mail.google.com/mail/u/0/";
  assert.ok(!sameDocumentUrl(`${gmail}#inbox/FMfcgAAA`, `${gmail}#inbox/FMfcgBBB`));
  assert.ok(sameDocumentUrl(`${gmail}#inbox/FMfcgAAA`, `${gmail}#inbox/FMfcgAAA`));
  // Each route also keys its own cached chat.
  assert.notStrictEqual(
    pageChatKey(`${gmail}#inbox/FMfcgAAA`),
    pageChatKey(`${gmail}#inbox/FMfcgBBB`)
  );
  assert.notStrictEqual(
    pageChatKey(`${ARTICLE}#/inbox`),
    pageChatKey(`${ARTICLE}#/archive`)
  );
  // A plain anchor on an ordinary host still collapses into one key.
  assert.strictEqual(pageChatKey(`${ARTICLE}#introduction`), ARTICLE);
});

test("a :~:text= directive never changes document identity", () => {
  const highlighted = `${ARTICLE}#:~:text=the%20exact%20quote`;
  assert.strictEqual(documentIdentityUrl(highlighted), ARTICLE);
  assert.ok(sameDocumentUrl(highlighted, ARTICLE));
  // Our own attribution navigation replaces one directive with the next.
  assert.ok(
    sameDocumentUrl(highlighted, `${ARTICLE}#:~:text=a%20different%20quote`)
  );
  // A page anchor combined with a directive resolves to the same document.
  assert.ok(sameDocumentUrl(`${ARTICLE}#part2:~:text=quote`, ARTICLE));
});

test("PDF page and zoom anchors keep one PDF document", () => {
  const pdf = "https://example.com/docs/report.pdf";
  assert.ok(sameDocumentUrl(`${pdf}#page=4&zoom=140`, pdf));
  assert.ok(sameDocumentUrl(`${pdf}#page=4`, `${pdf}#page=11`));
  assert.ok(sameDocumentUrl(`${pdf}#:~:text=revenue`, `${pdf}#page=2`));
  assert.ok(!sameDocumentUrl(pdf, "https://example.com/docs/other.pdf"));
});

test("query strings are part of document identity", () => {
  assert.ok(
    !sameDocumentUrl(`${ARTICLE}?page=2`, `${ARTICLE}?page=3`)
  );
  assert.ok(sameDocumentUrl(`${ARTICLE}?page=2#top`, `${ARTICLE}?page=2`));
  assert.strictEqual(
    documentIdentityUrl(`${ARTICLE}?page=2#top`),
    `${ARTICLE}?page=2`
  );
});

test("a YouTube watch page's identity is its video, not its playhead", () => {
  const watch = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  // Share links, chapter links, and resume links are one video at three
  // playback positions — one document, exactly like a "#section" anchor.
  assert.strictEqual(documentIdentityUrl(`${watch}&t=612`), watch);
  assert.strictEqual(documentIdentityUrl(`${watch}&t=612s`), watch);
  assert.strictEqual(documentIdentityUrl(`${watch}&start=90`), watch);
  assert.strictEqual(documentIdentityUrl(`${watch}&time_continue=45`), watch);
  assert.ok(sameDocumentUrl(`${watch}&t=612`, watch));
  assert.ok(sameDocumentUrl(`${watch}&t=612`, `${watch}&t=0`));
  assert.strictEqual(pageChatKey(`${watch}&t=612`), pageChatKey(watch));
  assert.strictEqual(pageChatKey(`${watch}&start=90&t=1`), pageChatKey(watch));

  // `?v=` is identity: another video is another chat.
  const otherVideo = "https://www.youtube.com/watch?v=abcdefghijk";
  assert.ok(!sameDocumentUrl(`${watch}&t=612`, otherVideo));
  assert.notStrictEqual(pageChatKey(watch), pageChatKey(otherVideo));
  // So is the surrounding playlist position.
  assert.ok(
    !sameDocumentUrl(`${watch}&list=PL9&index=2`, `${watch}&list=PL9&index=3`)
  );
  assert.strictEqual(
    pageChatKey(`${watch}&list=PL9&t=30`),
    pageChatKey(`${watch}&list=PL9`)
  );

  // The rule follows YouTube's hosts, including the short-link domain.
  for (const host of [
    "https://youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
  ]) {
    assert.ok(sameDocumentUrl(`${host}&t=99`, host), `${host} ignores t=`);
    assert.strictEqual(pageChatKey(`${host}&t=99`), pageChatKey(host));
  }
  assert.ok(
    sameDocumentUrl(
      "https://youtu.be/dQw4w9WgXcQ?t=99",
      "https://youtu.be/dQw4w9WgXcQ"
    )
  );
  // Different YouTube hosts remain different documents; normalizing a time
  // parameter never merges them.
  assert.notStrictEqual(
    pageChatKey("https://m.youtube.com/watch?v=dQw4w9WgXcQ"),
    pageChatKey(watch)
  );
});

test("the time-parameter rule never leaks off YouTube's hosts", () => {
  // `t` and `start` are ordinary, meaningful query parameters elsewhere.
  const other = "https://example.com/report";
  assert.ok(!sameDocumentUrl(`${other}?t=612`, other));
  assert.notStrictEqual(pageChatKey(`${other}?t=612`), pageChatKey(other));
  assert.strictEqual(pageChatKey(`${other}?start=90`), `${other}?start=90`);
  // Look-alike hosts are not YouTube.
  const lookalike = "https://youtube.com.evil.test/watch?v=abc";
  assert.notStrictEqual(pageChatKey(`${lookalike}&t=5`), pageChatKey(lookalike));
  assert.ok(!sameDocumentUrl(`${lookalike}&t=5`, lookalike));
  const notYoutube = "https://notyoutube.com/watch?v=abc";
  assert.ok(!sameDocumentUrl(`${notYoutube}&t=5`, notYoutube));
});

test("document identity handles unusable and non-http URLs", () => {
  assert.strictEqual(documentIdentityUrl(null), null);
  assert.strictEqual(documentIdentityUrl(undefined), null);
  assert.strictEqual(documentIdentityUrl(""), null);
  assert.strictEqual(documentIdentityUrl(`https://a.test/${"x".repeat(20_000)}`), null);
  // Two unknown URLs are never assumed to be the same document.
  assert.ok(!sameDocumentUrl(null, null));
  assert.ok(!sameDocumentUrl(ARTICLE, null));
  // file:// PDFs and the native viewer are compared the same way.
  assert.ok(
    sameDocumentUrl("file:///Users/a/report.pdf#page=3", "file:///Users/a/report.pdf")
  );
  // A relative string has no origin to parse; the fragment is still dropped.
  assert.strictEqual(documentIdentityUrl("not a url#hash"), "not a url");
});

test("pageChatKey is stable across hash-only changes", () => {
  const key = pageChatKey(ARTICLE);
  assert.strictEqual(key, ARTICLE);
  assert.strictEqual(pageChatKey(`${ARTICLE}#introduction`), key);
  assert.strictEqual(pageChatKey(`${ARTICLE}#summary`), key);
  assert.strictEqual(pageChatKey(`${ARTICLE}#:~:text=quoted%20source`), key);
  assert.strictEqual(pageChatKey(`${ARTICLE}#part2:~:text=quoted`), key);
  assert.strictEqual(pageChatKey(`${ARTICLE}#`), key);
});

test("pageChatKey keeps PDF anchors out of the key", () => {
  const pdf = "https://example.com/docs/report.pdf";
  assert.strictEqual(pageChatKey(`${pdf}#page=4&zoom=140`), pdf);
  assert.strictEqual(pageChatKey(`${pdf}#:~:text=revenue`), pdf);
});

test("pageChatKey preserves meaningful query strings", () => {
  assert.strictEqual(
    pageChatKey(`${ARTICLE}?page=2&sort=new`),
    `${ARTICLE}?page=2&sort=new`
  );
  // Order-independent, so one page has one key.
  assert.strictEqual(
    pageChatKey(`${ARTICLE}?sort=new&page=2`),
    pageChatKey(`${ARTICLE}?page=2&sort=new`)
  );
  assert.notStrictEqual(pageChatKey(`${ARTICLE}?page=2`), pageChatKey(ARTICLE));
});

test("pageChatKey drops tracking parameters but nothing else", () => {
  assert.strictEqual(
    pageChatKey(`${ARTICLE}?utm_source=x&UTM_Medium=y&fbclid=1&gclid=2&q=real`),
    `${ARTICLE}?q=real`
  );
  assert.strictEqual(
    pageChatKey(`${ARTICLE}?mc_cid=1&mc_eid=2`),
    ARTICLE
  );
});

test("pageChatKey rejects URLs a page chat cannot belong to", () => {
  assert.strictEqual(pageChatKey(null), null);
  assert.strictEqual(pageChatKey(""), null);
  assert.strictEqual(pageChatKey("chrome://settings"), null);
  assert.strictEqual(pageChatKey("file:///Users/a/report.pdf"), null);
  assert.strictEqual(pageChatKey("not a url"), null);
  assert.strictEqual(pageChatKey(`https://a.test/${"x".repeat(20_000)}`), null);
});

test("the cache key and the navigation guard agree on identity", () => {
  const cases = [
    [ARTICLE, `${ARTICLE}#section`],
    [`${ARTICLE}?page=2`, `${ARTICLE}?page=2#:~:text=quote`],
    ["https://example.com/docs/report.pdf", "https://example.com/docs/report.pdf#page=9"],
  ];
  for (const [left, right] of cases) {
    assert.ok(
      sameDocumentUrl(left, right),
      `${right} should be the same document as ${left}`
    );
    assert.strictEqual(
      pageChatKey(right),
      pageChatKey(left),
      `${right} should share a cache key with ${left}`
    );
  }
  // A real navigation is a real navigation on both sides.
  assert.ok(!sameDocumentUrl(`${ARTICLE}-two`, ARTICLE));
  assert.notStrictEqual(pageChatKey(`${ARTICLE}-two`), pageChatKey(ARTICLE));
});
