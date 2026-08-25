#!/usr/bin/env node
import {
  publishMobilePreviewWeb,
  resetMobilePreviewWorkspace,
  stageMobilePreviewProject,
} from "../lib/mobile-app-preview-stage.mjs";

const arguments_ = process.argv.slice(2);
if (arguments_[0] === "--reset-workspace" && arguments_.length === 2) {
  await resetMobilePreviewWorkspace(arguments_[1]);
} else if (arguments_[0] === "--publish-web" && arguments_.length === 4 && arguments_[2] === "--preview-root") {
  await publishMobilePreviewWeb(arguments_[1], arguments_[3]);
} else {
  const options = parseArguments(arguments_);
  await stageMobilePreviewProject(options.project, options.previewRoot);
}

function parseArguments(arguments_) {
  const options = { project: null, previewRoot: null };
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!value || !["--project", "--preview-root"].includes(name)) throw new Error(`移动预览同步参数无效：${name || "空"}`);
    options[name === "--project" ? "project" : "previewRoot"] = value;
  }
  if (!options.project || !options.previewRoot) throw new Error("移动预览同步参数不完整");
  return options;
}
