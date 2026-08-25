const CLOSING_MESSAGE_MARKER = "Its closing message:";

/**
 * Read the stable settlement source fields first and use the model-facing
 * content only for the optional final answer. The official runtime currently
 * renders a summary and a closing-message marker, but the source object is the
 * durable contract and must not be inferred from block ordering alone.
 */
export function parseOfficialSettlementMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const sourceSummary = typeof message?.source?.summary === "string"
    ? message.source.summary.trim()
    : "";
  const firstText = typeof blocks[0]?.text === "string" ? blocks[0].text : "";
  const summary = sourceSummary || firstText;
  const markerIndex = blocks.findIndex(
    (block) => block?.type === "text" && block.text === CLOSING_MESSAGE_MARKER,
  );
  let outputBlocks;
  if (markerIndex >= 0) {
    outputBlocks = blocks.slice(markerIndex + 1);
  } else {
    // A future renderer may omit the English marker or use a different block
    // layout. When the stable source summary occupies the first block, omit
    // that one block and preserve every remaining content block.
    outputBlocks = sourceSummary && firstText.trim() === sourceSummary
      ? blocks.slice(1)
      : blocks;
  }
  return {
    summary,
    finalResponse: textFromBlocks(outputBlocks),
  };
}

export function stopReasonFromOfficialSummary(summary) {
  const text = String(summary || "");
  if (text.includes("finished and will do no further work")) return "completed";
  if (text.includes("was stopped before it finished")) return "aborted";
  if (text.includes("ran out of room before it finished")) return "max-tokens";
  if (text.includes("declined the task")) return "refusal";
  if (text.includes("failed before it finished")) return "error";
  const abnormal = /ended abnormally \(([^)]+)\)/u.exec(text);
  return abnormal?.[1] || "error";
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}
