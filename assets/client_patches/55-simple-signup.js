(() => {
  const CAP_WIDGET_SRC = "/api/v9/auth/cap/widget.js";
  const emailRequired = window.GLOBAL_ENV?.REGISTER_EMAIL_REQUIRED === true;
  const emailRules = [
    [
      /\(0,[\w$]+\.jsx\)\([\w$.]+,\{autoFocus:!0,className:[\w$.]+,label:[^,]+,name:"email",[^]*?onBlur:\(\)=>[\w$]+\("email"\)\}\),/g,
      "",
    ],
    [
      /\{label:([^,]+),className:([\w$.]+),name:"global_name"/g,
      '{autoFocus:!0,label:$1,className:$2,name:"global_name"',
    ],
    [
      /(let ([\w$]+)=!1;)0===[\w$]+\.length&&\([\w$]+\([\w$]+\.intl\.string\([\w$.]+\)\),\2=!0\),(?=0===[\w$]+\.length&&[^;]*?0===[\w$]+\.length&&)/g,
      "$1",
    ],
  ];
  const rules = [
    ...(emailRequired ? [] : emailRules),
    [
      /\(0,[\w$]+\.jsx\)\([\w$.]+,\{label:[^,]+,wrapperClassName:[\w$.]+,name:"date_of_birth",[^]*?\}\),/g,
      "",
    ],
    [/null==[\w$]+&&\([\w$]+\([\w$]+\.intl\.string\([\w$.]+\)\),[\w$]+=!0\),/g, ""],
    [/"tUjnxr":\["Email or Phone Number"\]/g, '"tUjnxr":["Email or Username"]'],
    [/isClaimed\(\)\{return null!=this\.email\|\|null!=this\.phone\}/g, "isClaimed(){return!0}"],
    [
      /if\(null!=([\w$]+)&&[\w$]+\)return\(0,([\w$]+)\.jsx\)\(([\w$]+),\{invite:\1,authBoxClassName:/g,
      "if(!1)return(0,$2.jsx)($3,{invite:$1,authBoxClassName:",
    ],
    [
      /!([\w$]+)&&null!=([\w$]+)&&[\w$]+&&\2\.state===([\w$.]+)\.RESOLVED&&\(([\w$]+)=/g,
      "!$1&&null!=$2&&$2.state===$3.RESOLVED&&($4=",
    ],
    [
      /(case [\w$.]+\.RECAPTCHA:return\(0,([\w$]+)\.jsx\)\([\w$.]+,\{\.\.\.[\w$]+,onLoad:[\w$]+,onRender:[\w$]+,onVerify:([\w$]+),onError:([\w$]+),sitekey:[\w$]+\}\);)/g,
      'case"cap":return(0,$2.jsx)("div",{ref:window.fcCapChallenge($3,$4)});$1',
    ],
  ];
  const needles = [
    'name:"date_of_birth"',
    '"tUjnxr":[',
    "isClaimed(){return null!=this.email",
    ".RECAPTCHA_ENTERPRISE:",
  ];

  const patchModules = (modules) => {
    if (!modules || typeof modules !== "object") return;
    for (const id of Object.keys(modules)) {
      const factory = modules[id];
      if (typeof factory !== "function" || factory.__signupPatched) continue;
      const source = factory.toString();
      if (!needles.some((needle) => source.includes(needle))) continue;
      const patched = rules.reduce((code, [find, replace]) => code.replace(find, replace), source);
      if (patched === source) continue;
      try {
        const replacement = (0, eval)(`({${patched}})`)[id] ?? (0, eval)(`(${patched})`);
        replacement.__signupPatched = true;
        modules[id] = replacement;
      } catch (e) {
        console.error("[simple-signup] failed to patch module", id, e);
      }
    }
  };

  const chunks = (window.webpackChunkdiscord_app ??= []);
  chunks.forEach((chunk) => patchModules(chunk?.[1]));
  const previous = Object.getOwnPropertyDescriptor(chunks, "push");
  let current = previous?.value ?? Array.prototype.push;
  Object.defineProperty(chunks, "push", {
    configurable: true,
    get() {
      const target = previous?.get ? previous.get.call(this) : current;
      return function (...items) {
        items.forEach((chunk) => patchModules(chunk?.[1]));
        return target.apply(this, items);
      };
    },
    set(fn) {
      if (previous?.set) previous.set.call(this, fn);
      else current = fn;
    },
  });
  chunks.push([["sb-simple-signup"], {}, (require) => patchModules(require.m)]);

  const nativeFetch = window.fetch.bind(window);
  let config = null;
  const captchaConfig = () =>
    (config ??= nativeFetch(`${location.origin}/api/v9/auth/captcha`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null));

  let capScript = null;
  const loadCap = () =>
    (capScript ??= new Promise((resolve, reject) => {
      window.CAP_CUSTOM_WASM_URL = "/api/v9/auth/cap/cap_wasm_bg.wasm";
      window.CAP_CUSTOM_HASHWX_URL = "/api/v9/auth/cap/hashwx.wasm";
      window.CAP_PAKO_URL = "/api/v9/auth/cap/pako.js";
      window.CAP_DISABLE_WIDGET_REF = true;
      if (window.Cap) return resolve();
      const script = Object.assign(document.createElement("script"), {
        src: CAP_WIDGET_SRC,
        async: true,
        onload: resolve,
      });
      script.onerror = () => {
        capScript = null;
        script.remove();
        reject(new Error("Cap widget failed to load"));
      };
      document.head.append(script);
    }));

  const style = document.createElement("style");
  style.textContent = `
.fc-cap-challenge {
    width: 304px;
    max-width: 100%;
}
.fc-cap-challenge cap-widget {
    display: block;
    --cap-widget-width: 100%;
    --cap-widget-height: 64px;
    --cap-widget-padding: 16px;
    --cap-gap: 12px;
    border-radius: 8px;
    background: var(--input-background-default, hsl(0 0% 0% / 0.12));
    --cap-border-radius: 8px;
    --cap-background: transparent;
    --cap-border-color: var(--input-border-default, hsl(240 4% 61% / 0.2));
    --cap-color: var(--text-default, hsl(240 5% 94%));
    --cap-font: var(--font-primary, "gg sans", "Noto Sans", sans-serif);
    --cap-checkbox-size: 24px;
    --cap-checkbox-border-radius: 6px;
    --cap-checkbox-background: var(--background-base-lowest, hsl(240 6% 8%));
    --cap-checkbox-border: 1px solid var(--interactive-text-default, hsl(240 4% 70%));
    --cap-focus-ring: var(--focus-primary, hsl(197 100% 48%));
    --cap-spinner-color: var(--text-default, hsl(240 5% 94%));
    --cap-spinner-background-color: var(--background-mod-strong, hsl(240 4% 61% / 0.24));
    --cap-troubleshoot-color: var(--text-link, hsl(213 100% 72%));
}
`;
  document.documentElement.append(style);

  let hiddenWidget = null;
  window.fcCapChallenge = (onVerify, onError) => (slot) => {
    if (!slot || slot.firstChild) return;
    captchaConfig()
      .then(async (captcha) => {
        if (!captcha?.endpoint) throw new Error("Cap is not configured");
        await loadCap();
        if (!slot.isConnected || slot.firstChild) return;
        const challenge = document.createElement("cap-widget");
        challenge.setAttribute("data-cap-api-endpoint", captcha.endpoint);
        challenge.setAttribute("data-cap-i18n-initial-state", "Verify you're human");
        challenge.addEventListener("solve", (e) => onVerify(e.detail.token), { once: true });
        slot.className = "fc-cap-challenge";
        slot.replaceChildren(challenge);
      })
      .catch((e) => onError?.(e.message));
  };

  const solve = async (captcha) => {
    await loadCap();
    const target = (hiddenWidget ??= new window.Cap({ apiEndpoint: captcha.endpoint }).widget);
    const token =
      target.token ||
      (await new Promise((resolve) => {
        target.addEventListener("solve", (e) => resolve(e.detail.token), { once: true });
        target.addEventListener("error", () => resolve(null), { once: true });
        Promise.resolve(target.solve()).catch(() => resolve(null));
      }));
    target.reset();
    return token;
  };

  const flows = {
    "/auth/register": "register",
    "/auth/login": "login",
    "/auth/forgot": "password_reset",
    "/auth/verify": "register",
  };
  const pathOf = (url) => {
    try {
      return new URL(url, location.href).pathname.replace(/^\/api(\/v\d+)?/, "");
    } catch {
      return null;
    }
  };

  const prepare = async (path, body) => {
    if (typeof body !== "string") return body;
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return body;
    }
    if (path === "/auth/register") {
      if (!data.email) delete data.email;
      delete data.date_of_birth;
      delete data.promotional_email_opt_in;
    }
    const captcha = await captchaConfig();
    if (
      path !== "/auth/register" &&
      captcha?.service === "cap" &&
      captcha[flows[path]] &&
      !data.captcha_key
    )
      data.captcha_key = (await solve(captcha).catch(() => null)) ?? undefined;
    return JSON.stringify(data);
  };

  const { open, send } = XMLHttpRequest.prototype;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const path = pathOf(url);
    this.fcSignupPath = String(method).toUpperCase() === "POST" && flows[path] ? path : null;
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (!this.fcSignupPath) return send.call(this, body);
    prepare(this.fcSignupPath, body)
      .catch(() => body)
      .then((next) => {
        if (this.readyState === XMLHttpRequest.OPENED) send.call(this, next);
      });
  };

  window.fetch = async function (input, init) {
    const path = typeof input === "string" ? pathOf(input) : null;
    if (!flows[path] || String(init?.method).toUpperCase() !== "POST")
      return nativeFetch(input, init);
    return nativeFetch(input, { ...init, body: await prepare(path, init.body) });
  };
})();
