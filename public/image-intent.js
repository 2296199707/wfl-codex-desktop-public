const META_REQUEST_PREFIX = /^(?:请问[，,\s]*)?(?:怎么|如何|为什么|为何|能否|能不能|可否|可不可以|是否|哪里|在哪|检查|排查|修复|配置|设置|接入|调用|what\s|how\s|why\s|where\s|can\s+you\s|could\s+you\s|does\s|is\s)/i;
const IMAGE_COMMAND = /^\/(?:image|img|生图)(?:\s+|$)/i;
const CHINESE_VISUAL_NOUN = "(?:图片|图像|照片|插画|壁纸|海报|头像|封面|图标|表情包|宣传图|效果图|概念图|场景图|架构图|流程图)";
const CHINESE_ACTION_REQUEST = new RegExp(
  `^(?:(?:请|麻烦)[，,\\s]*)?(?:(?:帮我|给我|替我)[，,\\s]*)?(?:(?:我想(?:让你)?|我要|想要)[，,\\s]*)?(?:生成|绘制|画|制作|创建|设计|渲染|做)(?=[\\s\\S]{0,120}${CHINESE_VISUAL_NOUN})`,
);
const CHINESE_SHORT_REQUEST = new RegExp(
  `^(?:(?:请|麻烦)[，,\\s]*)?(?:(?:帮我|给我)[，,\\s]*)?(?:来|做|画)(?:一|几)?[张幅](?=[\\s\\S]{0,120}${CHINESE_VISUAL_NOUN})`,
);
const CHINESE_IMAGE_API_REQUEST = new RegExp(
  `^(?:(?:请|麻烦)[，,\\s]*)?(?:(?:帮我|给我|替我)[，,\\s]*)?(?:调用|使用|用|通过)(?:(?:当前|这个|已配置的|网页配置的|管理员配置的)[，,\\s]*)?(?:图片|生图)[，,\\s]*(?:API(?:[，,\\s]*(?:供应商|接口))?|接口|供应商)(?:来|并|，|,|\\s)*(?:生成|绘制|画|制作|创建|设计|渲染|做)(?=[\\s\\S]{0,120}${CHINESE_VISUAL_NOUN})`,
  "i",
);
const ENGLISH_IMAGE_REQUEST = /^(?:please\s+)?(?:(?:help|make)\s+me\s+)?(?:generate|create|draw|make|design|render)(?=[\s\S]{0,180}\b(?:image|picture|photo|illustration|poster|wallpaper|avatar|cover|icon|artwork|diagram)\b)/i;

export function imagePromptFromConversation(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 4_000) return null;

  if (IMAGE_COMMAND.test(text)) {
    const prompt = text.replace(IMAGE_COMMAND, "").trim();
    return prompt || null;
  }
  // "调用图片 API 生成…" is an explicit action, not a question about how
  // the API works. Check this narrow imperative form before the broad
  // meta-request guard, which intentionally treats other "调用…" prompts as
  // ordinary conversation.
  if (CHINESE_IMAGE_API_REQUEST.test(text)) return text;
  if (META_REQUEST_PREFIX.test(text)) return null;
  if (CHINESE_ACTION_REQUEST.test(text) || CHINESE_SHORT_REQUEST.test(text) || ENGLISH_IMAGE_REQUEST.test(text)) {
    return text;
  }
  return null;
}
