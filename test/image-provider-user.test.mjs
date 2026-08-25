import assert from "node:assert/strict";
import test from "node:test";
import {
  createImageProviderUserIdentifier,
  ImageProviderUserIdentifierError,
} from "../lib/image-provider-user.mjs";

const SECRET_A = "0123456789abcdef0123456789abcdef0123456789abc";
const SECRET_B = "fedcba9876543210fedcba9876543210fedcba987654";

test("creates a stable versioned ASCII identifier without exposing the user ID", () => {
  const input = { userId: "user_01J8SENSITIVE", secret: SECRET_A };
  const first = createImageProviderUserIdentifier(input);
  const second = createImageProviderUserIdentifier(input);

  assert.equal(first, second);
  assert.match(first, /^wfl-image-user-v1_[A-Za-z0-9_-]{43}$/);
  assert.equal(first.length <= 256, true);
  assert.match(first, /^[\x20-\x7e]+$/);
  assert.equal(first.includes(input.userId), false);
});

test("keeps users isolated and rotates identifiers when the secret changes", () => {
  const firstUser = createImageProviderUserIdentifier({ userId: "user-a", secret: SECRET_A });
  const secondUser = createImageProviderUserIdentifier({ userId: "user-b", secret: SECRET_A });
  const rotated = createImageProviderUserIdentifier({ userId: "user-a", secret: SECRET_B });

  assert.notEqual(firstUser, secondUser);
  assert.notEqual(firstUser, rotated);
  assert.notEqual(secondUser, rotated);
});

test("accepts binary session secrets and keeps the namespace contract fixed", () => {
  const identifier = createImageProviderUserIdentifier({
    userId: "legacy-owner",
    secret: Buffer.from(SECRET_A),
  });

  assert.equal(identifier, "wfl-image-user-v1_-s6PQ3QUKkTznsL4fHzgIErZxfB9yYl5-CqKAysoXXA");
});

test("rejects empty, non-string, and abnormally large user identifiers", () => {
  const invalidUserIds = [undefined, null, "", "   ", 123, "x".repeat(1025), "用".repeat(342)];
  for (const userId of invalidUserIds) {
    assert.throws(
      () => createImageProviderUserIdentifier({ userId, secret: SECRET_A }),
      (error) => {
        assert.ok(error instanceof ImageProviderUserIdentifierError);
        assert.equal(error.code, "INVALID_IMAGE_PROVIDER_USER_ID");
        if (typeof userId === "string" && userId) assert.equal(error.message.includes(userId), false);
        return true;
      },
    );
  }
});

test("rejects empty, invalid, and abnormally large secrets", () => {
  const invalidSecrets = [undefined, null, "", "   ", Buffer.alloc(0), 123, "x".repeat(4097)];
  for (const secret of invalidSecrets) {
    assert.throws(
      () => createImageProviderUserIdentifier({ userId: "user-a", secret }),
      (error) => {
        assert.ok(error instanceof ImageProviderUserIdentifierError);
        assert.equal(error.code, "INVALID_IMAGE_PROVIDER_USER_SECRET");
        return true;
      },
    );
  }
});
