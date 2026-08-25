import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

await import("../public/i18n.js");

const {
  DEFAULT_LANGUAGE,
  ENGLISH_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  PROTECTED_CONTENT_SELECTOR,
  isProtectedElement,
  normalizeLanguage,
  resolveTranslationState,
  translateNodeValue,
  translateText,
} = globalThis.WFLI18nCore;

test("normalizes supported languages and defaults to Simplified Chinese", () => {
  assert.equal(DEFAULT_LANGUAGE, "zh-CN");
  assert.equal(ENGLISH_LANGUAGE, "en");
  assert.equal(LANGUAGE_STORAGE_KEY, "codexDesktop.language");
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage("EN-us"), "en");
  assert.equal(normalizeLanguage("zh-Hans"), "zh-CN");
  assert.equal(normalizeLanguage("fr"), "zh-CN");
  assert.equal(normalizeLanguage(null), "zh-CN");
});

test("translates common page chrome while preserving whitespace and unknown content", () => {
  assert.equal(translateText("正在连接", "en"), "Connecting");
  assert.equal(translateText("  用户管理  ", "en-US"), "  User management  ");
  assert.equal(translateText("保存并启用", "en"), "Save and activate");
  assert.equal(translateText("正在连接", "zh-CN"), "正在连接");
  assert.equal(translateText("这是用户自己写的内容", "en"), "这是用户自己写的内容");
});

test("translates bounded dynamic UI status patterns", () => {
  assert.equal(translateText("API 重连 3/5", "en"), "API reconnect 3/5");
  assert.equal(translateText("已运行 2 小时 4 分", "en"), "Running for 2 hr 4 min");
  assert.equal(translateText("3 个活动任务 · 2 个连接", "en"), "3 active tasks · 2 connections");
  assert.equal(translateText("当前版本 0.36.3，检查升级", "en"), "Current version 0.36.3; check for updates");
  assert.equal(translateText("显示更早的 28 轮", "en"), "Show 28 earlier turns");
  assert.equal(translateText("套餐有效期至 2026/08/01", "en"), "Plan valid through 2026/08/01");
  assert.equal(
    translateText("永久删除“Release notes”？此操作无法撤销。", "en"),
    "Permanently delete “Release notes”? This cannot be undone.",
  );
});

test("restores the latest Chinese source after an English rendering", () => {
  const english = resolveTranslationState(null, "正在连接", "en");
  assert.deepEqual(english, { source: "正在连接", rendered: "Connecting", language: "en" });
  const updated = resolveTranslationState(english, "正在处理", "en");
  assert.deepEqual(updated, { source: "正在处理", rendered: "Working", language: "en" });
  const chinese = resolveTranslationState(updated, updated.rendered, "zh-CN");
  assert.deepEqual(chinese, { source: "正在处理", rendered: "正在处理", language: "zh-CN" });
});

test("protects conversations, tool output, and project content from DOM translation", () => {
  assert.match(PROTECTED_CONTENT_SELECTOR, /\.message-list/);
  assert.match(PROTECTED_CONTENT_SELECTOR, /\.message-text/);
  assert.match(PROTECTED_CONTENT_SELECTOR, /\.tool-output/);
  assert.match(PROTECTED_CONTENT_SELECTOR, /\.resource-editor/);
  assert.match(PROTECTED_CONTENT_SELECTOR, /\[data-i18n-ignore\]/);
  assert.doesNotMatch(PROTECTED_CONTENT_SELECTOR, /\.resource-preview/);
  assert.doesNotMatch(PROTECTED_CONTENT_SELECTOR, /\.project-row \.row-copy/);
  assert.doesNotMatch(PROTECTED_CONTENT_SELECTOR, /(?:^|,)textarea(?:,|$)/);

  const conversationElement = {
    closest(selector) {
      return selector.includes(".message-list") ? this : null;
    },
  };
  assert.equal(isProtectedElement(conversationElement), true);
  assert.equal(translateText("正在连接", "en"), "Connecting");
  assert.equal(
    translateNodeValue("正在连接", "en", conversationElement),
    "正在连接",
    "protected conversation content remains untouched by the DOM runtime",
  );
});

test("preserves business data that collides with interface dictionary keys", () => {
  const protectedDataElement = {
    closest(selector) {
      return selector.includes("[data-i18n-ignore]") ? this : null;
    },
  };
  for (const value of ["管理员", "工程", "供应商", "文件", "更新"]) {
    assert.notEqual(translateText(value, "en"), value, `${value} is a known interface translation`);
    assert.equal(
      translateNodeValue(value, "en", protectedDataElement),
      value,
      `${value} remains unchanged when it is a username, project, provider, plan, file, or log value`,
    );
  }
});

test("keeps dictionary keys and dynamic rules unique", async () => {
  const source = await fs.readFile(new URL("../public/i18n.js", import.meta.url), "utf8");
  const dictionaryBody = source.match(/const ENGLISH_TRANSLATIONS = Object\.freeze\(\{([\s\S]*?)\n  \}\);/u)?.[1];
  const dynamicBody = source.match(/const DYNAMIC_TRANSLATIONS = Object\.freeze\(\[([\s\S]*?)\n  \]\);/u)?.[1];
  assert.ok(dictionaryBody, "translation dictionary is discoverable");
  assert.ok(dynamicBody, "dynamic translation rules are discoverable");

  const keys = [...dictionaryBody.matchAll(/^\s*"((?:\\.|[^"\\])+)":/gmu)].map((match) => match[1]);
  const patterns = [...dynamicBody.matchAll(/^\s*\[\/(.+)\/u,/gmu)].map((match) => match[1]);
  assert.equal(new Set(keys).size, keys.length, "translation dictionary keys must be unique");
  assert.equal(new Set(patterns).size, patterns.length, "dynamic translation rules must be unique");
});
