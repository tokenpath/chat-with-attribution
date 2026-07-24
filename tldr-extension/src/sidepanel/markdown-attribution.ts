import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};

type TextLeaf = {
  start: number;
  end: number;
  value: string;
  ancestors: string[];
};

// These containers do not transform the raw contents of a text leaf. Links,
// code, HTML, footnotes, and other extensions deliberately fall back to the
// exact plain renderer instead of risking malformed or double-action markup.
const SAFE_TEXT_ANCESTORS = new Set([
  "root",
  "paragraph",
  "heading",
  "strong",
  "emphasis",
  "delete",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
]);

export function normalizeAttributions(
  answer: string,
  attributions: TldrAttribution[]
): TldrAttribution[] {
  const sorted = [...(Array.isArray(attributions) ? attributions : [])]
    .filter(
      (item) =>
        Number.isInteger(item.answerStart) &&
        Number.isInteger(item.answerEnd) &&
        item.answerStart >= 0 &&
        item.answerEnd > item.answerStart &&
        item.answerStart < answer.length &&
        Number.isFinite(item.sourceStart) &&
        Number.isFinite(item.sourceEnd) &&
        item.sourceEnd > item.sourceStart
    )
    .sort((left, right) => left.answerStart - right.answerStart);

  const usable: TldrAttribution[] = [];
  let cursor = 0;
  for (const attribution of sorted) {
    if (attribution.answerStart < cursor) continue;
    const answerEnd = Math.min(attribution.answerEnd, answer.length);
    usable.push({ ...attribution, answerEnd });
    cursor = answerEnd;
  }
  return usable;
}

function collectTextLeaves(
  node: MarkdownNode,
  ancestors: string[],
  leaves: TextLeaf[]
) {
  if (node.type === "text") {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (
      typeof node.value === "string" &&
      Number.isInteger(start) &&
      Number.isInteger(end)
    ) {
      leaves.push({
        start: start as number,
        end: end as number,
        value: node.value,
        ancestors,
      });
    }
    return;
  }

  for (const child of node.children || []) {
    collectTextLeaves(child, [...ancestors, node.type], leaves);
  }
}

export function supportsAttributedMarkdown(
  answer: string,
  attributions: TldrAttribution[]
): boolean {
  if (attributions.length === 0) return true;

  let tree: MarkdownNode;
  try {
    tree = fromMarkdown(answer, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as MarkdownNode;
  } catch {
    return false;
  }

  const leaves: TextLeaf[] = [];
  collectTextLeaves(tree, [], leaves);

  return attributions.every((attribution) => {
    const containingLeaves = leaves.filter(
      (leaf) =>
        attribution.answerStart >= leaf.start &&
        attribution.answerEnd <= leaf.end
    );
    if (containingLeaves.length !== 1) return false;

    const [leaf] = containingLeaves;
    if (
      leaf.ancestors.some((ancestor) => !SAFE_TEXT_ANCESTORS.has(ancestor))
    ) {
      return false;
    }

    // Entity decoding and backslash escapes change a text node's rendered
    // value relative to its raw source offsets. Reject those nodes.
    if (answer.slice(leaf.start, leaf.end) !== leaf.value) return false;

    // A custom inline HTML wrapper is not reliable across a Markdown line.
    return !answer
      .slice(attribution.answerStart, attribution.answerEnd)
      .includes("\n");
  });
}
