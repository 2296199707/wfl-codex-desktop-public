import assert from "node:assert/strict";
import test from "node:test";

import {
  imageContextPolicy,
  imageOutputConversationAttachment,
  imageOutputMetadataReference,
  normalizeImageContextScope,
  sanitizeVisualReviewReport,
} from "../public/image-context-policy.js";

test("image context scopes must be explicit and keep map assets isolated", () => {
  assert.throws(() => normalizeImageContextScope(), /必须明确指定/u);
  assert.throws(() => normalizeImageContextScope(null), /必须明确指定/u);
  assert.throws(() => normalizeImageContextScope(""), /必须明确指定/u);
  assert.throws(() => normalizeImageContextScope("   "), /必须明确指定/u);
  assert.equal(normalizeImageContextScope("map-editor"), "map-editor");
  assert.equal(normalizeImageContextScope("visual-review"), "visual-review");
  assert.throws(() => normalizeImageContextScope("map-edtor"), /图片上下文作用域无效/u);
  assert.throws(() => imageContextPolicy(), /必须明确指定/u);

  assert.deepEqual(imageContextPolicy("conversation"), {
    scope: "conversation",
    allowConversationAttachment: true,
    destination: "conversation",
    actionLabel: "加入对话",
  });
  assert.deepEqual(imageContextPolicy("map-editor"), {
    scope: "map-editor",
    allowConversationAttachment: false,
    destination: "map-candidate",
    actionLabel: "加入地图候选",
  });
  assert.deepEqual(imageContextPolicy("character-editor"), {
    scope: "character-editor",
    allowConversationAttachment: false,
    destination: "character-candidate",
    actionLabel: "加入角色候选",
  });
  assert.equal(imageContextPolicy("visual-review").allowConversationAttachment, false);
});

test("only conversation-scoped image outputs can become localImage attachments", () => {
  const output = {
    path: "/srv/projects/demo/assets/tree.png",
    mediaType: "image/png",
    size: 1234,
  };
  assert.equal(imageOutputConversationAttachment(output, "conversation"), null);
  assert.deepEqual(imageOutputConversationAttachment(output, "conversation", { userSelected: true }), {
    name: "tree.png",
    path: output.path,
    mediaType: "image/png",
    size: 1234,
  });
  assert.equal(imageOutputConversationAttachment(output, "map-editor"), null);
  assert.equal(imageOutputConversationAttachment(output, "character-editor"), null);
  assert.equal(imageOutputConversationAttachment(output, "visual-review"), null);
  assert.equal(imageOutputConversationAttachment(output), null);
  assert.equal(imageOutputConversationAttachment(output, ""), null);
  assert.equal(imageOutputConversationAttachment(output, "unknown"), null);
  assert.equal(imageOutputConversationAttachment({ ...output, mediaType: "text/plain" }, "conversation"), null);
  assert.equal(
    imageOutputConversationAttachment({ ...output, path: "data:image/png;base64,secret" }, "conversation", { userSelected: true }),
    null,
  );
  assert.deepEqual(imageOutputConversationAttachment({
    ...output,
    width: 64,
    height: 32,
    sha256: "A".repeat(64),
  }, "conversation", { userSelected: true }), {
    name: "tree.png",
    path: output.path,
    mediaType: "image/png",
    size: 1234,
    width: 64,
    height: 32,
    sha256: "a".repeat(64),
  });
});

test("metadata references stay lightweight and never imply a conversation attachment", () => {
  const reference = imageOutputMetadataReference({
    ...outputFixture(),
    width: 1536,
    height: 1024,
    sha256: "A".repeat(64),
    operation: "generate",
    result: "data:image/png;base64,should-not-copy",
  }, "conversation");
  assert.deepEqual(reference, {
    context: "conversation",
    destination: "conversation",
    name: "tree.png",
    path: "/srv/projects/demo/assets/tree.png",
    mediaType: "image/png",
    size: 1234,
    width: 1536,
    height: 1024,
    sha256: "a".repeat(64),
    operation: "generate",
  });
  assert.equal(imageOutputMetadataReference(outputFixture(), "map-editor").context, "map-editor");
  assert.equal(imageOutputMetadataReference(outputFixture()), null);
});

function outputFixture() {
  return {
    path: "/srv/projects/demo/assets/tree.png",
    name: "tree.png",
    mediaType: "image/png",
    size: 1234,
  };
}

test("visual review reports are bounded structured data without image payloads or paths", () => {
  const report = sanitizeVisualReviewReport({
    summary: "Tree sprite has a light fringe.",
    tags: ["tree", "prop", "tree", "x".repeat(300)],
    issues: [{
      code: "alpha-fringe",
      severity: "warning",
      message: "White pixels remain around the crown.",
      confidence: 0.92,
      region: { x: 10, y: 20, width: 30, height: 40 },
      image: "data:image/png;base64,secret",
      sourcePath: "/srv/projects/demo/assets/tree.png",
    }],
    scores: { alpha: 0.72, composition: 1.5, ignored: "no" },
    recommendations: ["Remove the fringe", "Check the anchor"],
    image: "data:image/png;base64,secret",
    path: "/srv/projects/demo/assets/tree.png",
    rawProviderResponse: { output: "secret" },
  });

  assert.deepEqual(report, {
    summary: "Tree sprite has a light fringe.",
    tags: ["tree", "prop", "[已移除图片数据]"],
    issues: [{
      code: "alpha-fringe",
      severity: "warning",
      message: "White pixels remain around the crown.",
      confidence: 0.92,
      region: { x: 10, y: 20, width: 30, height: 40 },
    }],
    scores: { alpha: 0.72, composition: 1 },
    recommendations: ["Remove the fringe", "Check the anchor"],
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /data:image|base64|sourcePath|\/srv\/projects|rawProviderResponse/u);
});

test("visual review text fields redact disguised image data, paths, provider payloads, and keys", () => {
  const report = sanitizeVisualReviewReport({
    summary: "Preview data:image/png;base64,c2VjcmV0 and /srv/projects/demo/private.png",
    tags: [`base64:${"A".repeat(120)}`, "C:\\Users\\owner\\secret.png"],
    issues: [{
      code: "providerResponse=secret-payload",
      severity: "warning",
      message: `rawProviderResponse:private ${"B".repeat(120)} sk-test_secret_token_1234567890`,
    }],
    recommendations: ["Inspect /tmp/private/output.png and data:image/webp;base64,AAAA"],
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /data:image|base64|\/srv\/|\/tmp\/|C:\\Users|rawProviderResponse|providerResponse|sk-test/u);
  assert.match(serialized, /已移除/u);
});
