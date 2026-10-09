/* SPDX-License-Identifier: AGPL-3.0-only */
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../../assets/client_patches/55-simple-signup.js"), "utf8");
const signupModule = `({ 1(a, b, c) {let v=!1;0===m.length&&(s1(i.intl.string(i.t.k)),v=!0),0===u.length&&(s2(i.intl.string(i.t.k)),v=!0),0===p.length&&(s3(i.intl.string(i.t.k)),v=!0),null==d&&(s4(i.intl.string(i.t.k)),v=!0),v||go();return[(0,r.jsx)(f.Input,{autoFocus:!0,className:z.row,label:i.intl.string(i.t.e),name:"email",value:m,onBlur:()=>blur("email")}),(0,r.jsx)(f.Input,{label:i.intl.string(i.t.g),className:z.row,name:"global_name",value:n}),(0,r.jsx)(f.Date,{label:i.intl.string(i.t.b),wrapperClassName:z.dob,name:"date_of_birth",value:d}),(0,r.jsx)(f.Terms,{})]} })`;

function patchedSignup(env) {
    const context = vm.createContext({
        URL,
        console,
        location: { origin: "http://localhost", href: "http://localhost/register" },
        document: { createElement: () => ({}), documentElement: { append() {} }, head: { append() {} } },
        XMLHttpRequest: class {
            open() {}
            send() {}
        },
    });
    const modules = vm.runInContext(signupModule, context);
    context.window = { GLOBAL_ENV: env, fetch() {}, webpackChunkdiscord_app: [[["signup"], modules]] };
    vm.runInContext(script, context);
    return String(modules[1]);
}

test("the signup form has no email field unless the instance requires one", () => {
    for (const env of [undefined, {}, { REGISTER_EMAIL_REQUIRED: false }, { REGISTER_EMAIL_REQUIRED: "true" }]) {
        const source = patchedSignup(env);
        assert.equal(source.includes('name:"email"'), false);
        assert.equal(source.includes("0===m.length"), false);
        assert.ok(source.includes('{autoFocus:!0,label:i.intl.string(i.t.g),className:z.row,name:"global_name"'));
        assert.ok(source.includes("0===u.length&&") && source.includes("0===p.length&&"));
    }
});

test("the signup form keeps its required email field when the instance requires one", () => {
    const source = patchedSignup({ REGISTER_EMAIL_REQUIRED: true });
    assert.ok(source.includes('{autoFocus:!0,className:z.row,label:i.intl.string(i.t.e),name:"email"'));
    assert.ok(source.includes("let v=!1;0===m.length&&(s1("));
    assert.ok(source.includes('{label:i.intl.string(i.t.g),className:z.row,name:"global_name"'));
});

test("the signup form never asks for a date of birth", () => {
    for (const required of [false, true]) {
        const source = patchedSignup({ REGISTER_EMAIL_REQUIRED: required });
        assert.equal(source.includes("date_of_birth"), false);
        assert.equal(source.includes("null==d&&"), false);
        assert.ok(source.includes("(0,r.jsx)(f.Terms,{})"));
    }
});
