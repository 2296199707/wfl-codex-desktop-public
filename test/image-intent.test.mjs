import assert from "node:assert/strict";
import test from "node:test";
import { imagePromptFromConversation } from "../public/image-intent.js";

test("recognizes explicit image requests in ordinary conversations", () => {
  for (const prompt of [
    "生成一张猫咪图片",
    "请帮我画一幅海边插画",
    "给我创建一个机器人头像",
    "我想让你设计一张活动海报",
    "调用图片 API 供应商生成一张白底黄色香蕉图片",
    "请使用已配置的生图接口制作一张城市海报",
    "Generate an image of a cat",
    "Please draw a picture of a lighthouse",
  ]) {
    assert.equal(imagePromptFromConversation(prompt), prompt);
  }
  assert.equal(imagePromptFromConversation("/image a quiet mountain lake"), "a quiet mountain lake");
  assert.equal(imagePromptFromConversation("/生图 霓虹灯下的未来城市"), "霓虹灯下的未来城市");
});

test("keeps image questions, troubleshooting, and analysis in ordinary chat", () => {
  for (const prompt of [
    "怎么生成图片",
    "为什么生成图片失败",
    "检查一下图片生成 API",
    "如何调用图片 API 生成图片",
    "检查图片 API 能否生成图片",
    "配置图片供应商模型",
    "这张图片里有什么",
    "帮我修改图片生成代码",
    "How do I generate an image?",
    "Can you generate images?",
    "",
  ]) {
    assert.equal(imagePromptFromConversation(prompt), null);
  }
});
