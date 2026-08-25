import assert from "node:assert/strict";
import test from "node:test";

import {
  bindConversationImageContext,
  commitConversationImageContext,
  imageAttachmentIdentity,
  imageAttachmentMetadata,
  imageContextKey,
  MAX_IMAGE_CONTEXT_KEYS,
  MAX_IMAGES_PER_CONTEXT,
  prepareConversationImageContext,
} from "../public/image-attachment-context.js";

const image = {
  name: "tree.png",
  path: "/srv/projects/game/assets/tree.png",
  mediaType: "image/png",
  size: 123,
  width: 64,
  height: 64,
  sha256: "a".repeat(64),
};

test("ordinary conversations always send full images and never touch the ledger", () => {
  const ledger = new Map([["existing", new Set([`sha256:${"a".repeat(64)}`])]]);
  const prepared = prepareConversationImageContext([{ ...image, forceResend: true }], {
    ledger,
    contextKey: "existing",
    projectPath: "/srv/projects/game",
  });
  assert.equal(prepared.attachments.length, 1);
  assert.equal(prepared.attachments[0].forceResend, false);
  assert.deepEqual(prepared.references, []);
  assert.deepEqual(prepared.transaction, { contextKey: "", identities: [] });
  commitConversationImageContext(ledger, prepared.transaction);
  assert.equal(ledger.get("existing").size, 1);
});

test("conversation image bytes are sent once per isolated thread ledger", () => {
  const ledger = new Map();
  const key = imageContextKey({ runtime: "codex", windowId: "w1", projectPath: "/srv/projects/game", threadId: "t1" });
  const first = prepareConversationImageContext([image], {
    ledger, contextKey: key, projectPath: "/srv/projects/game", isolationEnabled: true,
  });
  commitConversationImageContext(ledger, first.transaction);
  const second = prepareConversationImageContext([image], {
    ledger, contextKey: key, projectPath: "/srv/projects/game", isolationEnabled: true,
  });
  assert.equal(first.attachments.length, 1);
  assert.equal(second.attachments.length, 0);
  assert.match(second.references[0], /assets\/tree\.png/u);
  assert.match(second.references[0], /sha256=/u);
  assert.match(second.references[0], /未重新发送图片字节/u);
  assert.doesNotMatch(JSON.stringify(second), /data:image|base64/iu);
});

test("explicit resend sends bytes again and other threads/windows are independent", () => {
  const ledger = new Map();
  const key = imageContextKey({ runtime: "codex", windowId: "w1", projectPath: "/p", threadId: "t1" });
  const first = prepareConversationImageContext([image], { ledger, contextKey: key, isolationEnabled: true });
  commitConversationImageContext(ledger, first.transaction);
  const resend = prepareConversationImageContext([{ ...image, forceResend: true }], {
    ledger, contextKey: key, isolationEnabled: true,
  });
  assert.equal(resend.attachments.length, 1);
  const other = prepareConversationImageContext([image], {
    ledger,
    contextKey: imageContextKey({ runtime: "codex", windowId: "w2", projectPath: "/p", threadId: "t1" }),
    isolationEnabled: true,
  });
  assert.equal(other.attachments.length, 1);
});

test("accounts are isolated and duplicate hashes are sent only once per turn", () => {
  const ledger = new Map();
  const firstAccount = imageContextKey({ accountId: "user-a", runtime: "codex", windowId: "w", projectPath: "/p", threadId: "t" });
  const secondAccount = imageContextKey({ accountId: "user-b", runtime: "codex", windowId: "w", projectPath: "/p", threadId: "t" });
  const prepared = prepareConversationImageContext([
    image,
    { ...image, name: "tree-copy.png", path: "/srv/projects/game/assets/tree-copy.png" },
  ], { ledger, contextKey: firstAccount, projectPath: "/srv/projects/game", isolationEnabled: true });
  assert.equal(prepared.attachments.length, 1);
  assert.equal(prepared.references.length, 1);
  commitConversationImageContext(ledger, prepared.transaction);
  assert.equal(prepareConversationImageContext([image], {
    ledger, contextKey: firstAccount, isolationEnabled: true,
  }).attachments.length, 0);
  assert.equal(prepareConversationImageContext([image], {
    ledger, contextKey: secondAccount, isolationEnabled: true,
  }).attachments.length, 1);
  const longPrefix = "x".repeat(700);
  assert.notEqual(
    imageContextKey({ accountId: "user-a", projectPath: `/${longPrefix}`, threadId: `${longPrefix}-one` }),
    imageContextKey({ accountId: "user-a", projectPath: `/${longPrefix}`, threadId: `${longPrefix}-two` }),
  );
});

test("draft ledger can be rebound to the actual thread", () => {
  const ledger = new Map();
  const draft = imageContextKey({ runtime: "codex", windowId: "w", projectPath: "/p", threadId: "draft:1" });
  const thread = imageContextKey({ runtime: "codex", windowId: "w", projectPath: "/p", threadId: "t" });
  const prepared = prepareConversationImageContext([image], { ledger, contextKey: draft, isolationEnabled: true });
  commitConversationImageContext(ledger, bindConversationImageContext(prepared.transaction, thread));
  assert.equal(prepareConversationImageContext([image], {
    ledger, contextKey: thread, isolationEnabled: true,
  }).attachments.length, 0);
});

test("failed or delivery-unknown sends do not consume the first image transmission", () => {
  const ledger = new Map();
  const key = imageContextKey({ runtime: "codex", windowId: "w", projectPath: "/p", threadId: "t" });
  const attempt = prepareConversationImageContext([image], { ledger, contextKey: key, isolationEnabled: true });
  assert.equal(attempt.attachments.length, 1);
  assert.equal(ledger.size, 0);
  const retry = prepareConversationImageContext([image], { ledger, contextKey: key, isolationEnabled: true });
  assert.equal(retry.attachments.length, 1);
  commitConversationImageContext(ledger, retry.transaction);
  assert.equal(prepareConversationImageContext([image], {
    ledger, contextKey: key, isolationEnabled: true,
  }).attachments.length, 0);
});

test("conversation image ledgers remain bounded in memory", () => {
  const ledger = new Map();
  for (let index = 0; index < MAX_IMAGE_CONTEXT_KEYS + 3; index += 1) {
    commitConversationImageContext(ledger, {
      contextKey: `context-${index}`,
      identities: [`sha256:${index.toString(16).padStart(64, "0")}`],
    });
  }
  assert.equal(ledger.size, MAX_IMAGE_CONTEXT_KEYS);
  assert.equal(ledger.has("context-0"), false);
  const identities = Array.from({ length: MAX_IMAGES_PER_CONTEXT + 9 }, (_, index) =>
    `sha256:${(index + 500).toString(16).padStart(64, "0")}`);
  commitConversationImageContext(ledger, { contextKey: "bounded-images", identities });
  assert.equal(ledger.get("bounded-images").size, MAX_IMAGES_PER_CONTEXT);
});

test("metadata uses project-relative paths and identities prefer sha256", () => {
  assert.equal(imageAttachmentIdentity(image), `sha256:${"a".repeat(64)}`);
  assert.equal(imageAttachmentIdentity({ ...image, sha256: undefined }), null);
  const metadata = imageAttachmentMetadata(image, "/srv/projects/game");
  assert.match(metadata, /^图片引用：assets\/tree\.png/u);
  assert.doesNotMatch(metadata, /\/srv\/projects/u);
  assert.doesNotMatch(metadata, /data:image|base64/u);
});
