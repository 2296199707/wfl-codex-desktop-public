const elements = {
  loginForm: document.getElementById("loginForm"),
  loginTab: document.getElementById("loginTab"),
  registerTab: document.getElementById("registerTab"),
  modeLabel: document.getElementById("modeLabel"),
  loginTitle: document.getElementById("loginTitle"),
  loginSummary: document.getElementById("loginSummary"),
  passwordInput: document.getElementById("passwordInput"),
  passwordHint: document.getElementById("passwordHint"),
  formError: document.getElementById("formError"),
  submitButton: document.getElementById("submitButton"),
};
const invitationToken = new URLSearchParams(location.search).get("invite")?.trim() || "";
const invitationAvailable = /^[A-Za-z0-9_-]{43}$/.test(invitationToken);
let registrationMode = invitationAvailable;

initialize();

async function initialize() {
  elements.loginTab.addEventListener("click", () => setMode(false));
  elements.registerTab.addEventListener("click", () => setMode(true));
  elements.loginForm.addEventListener("submit", submitForm);
  elements.registerTab.hidden = !invitationAvailable;
  try {
    const response = await fetch("/api/auth/mode", { cache: "no-store" });
    const mode = await response.json();
    if (!response.ok) {
      showError("暂时无法读取登录模式，请稍后重试。");
      return;
    }
    if (!mode.enabled) {
      elements.modeLabel.textContent = "单用户访问";
      elements.registerTab.hidden = true;
      elements.registerTab.disabled = true;
      setMode(false);
      elements.loginSummary.textContent = mode.authConfigured === false
        ? "当前未设置网页密码，可直接进入工作区。"
        : "使用网页用户名和密码继续。";
      return;
    }
    setMode(registrationMode);
  } catch {
    showError("暂时无法连接服务，请稍后重试。");
  }
}

function setMode(registering) {
  registrationMode = registering && invitationAvailable;
  registering = registrationMode;
  elements.loginTab.classList.toggle("active", !registering);
  elements.registerTab.classList.toggle("active", registering);
  elements.loginTab.setAttribute("aria-selected", String(!registering));
  elements.registerTab.setAttribute("aria-selected", String(registering));
  elements.passwordInput.autocomplete = registering ? "new-password" : "current-password";
  elements.passwordHint.hidden = !registering;
  elements.loginTitle.textContent = registering ? "创建工作区账号" : "登录工作区";
  elements.loginSummary.textContent = registering
    ? "设置用户名和密码完成邀请注册。"
    : "使用你的工作区账号继续。";
  elements.submitButton.textContent = registering ? "创建账号并登录" : "登录";
  elements.formError.textContent = "";
}

async function submitForm(event) {
  event.preventDefault();
  elements.submitButton.disabled = true;
  elements.formError.textContent = "";
  const body = {
    username: elements.loginForm.username.value.trim(),
    password: elements.passwordInput.value,
  };
  const endpoint = registrationMode ? "/api/auth/register" : "/api/auth/login";
  if (registrationMode) {
    body.invite = invitationToken;
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Codex-Desktop-Action": registrationMode ? "register" : "login" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "操作失败");
    const next = new URLSearchParams(location.search).get("next");
    location.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
  } catch (error) {
    showError(error.message);
    elements.submitButton.disabled = false;
  } finally {
    elements.passwordInput.value = "";
  }
}

function showError(message) {
  elements.formError.textContent = message;
}
