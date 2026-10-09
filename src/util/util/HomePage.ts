/* SPDX-License-Identifier: AGPL-3.0-only */
import fs from "node:fs";
import path from "node:path";
import { Config } from "./Config";
import { PUBLIC_ASSETS_FOLDER } from "./Constants";
import { brandPage, instanceName } from "./Branding";

const escapeHtml = (text: string) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const homePage = () => {
    const { general, register } = Config.get();
    const name = escapeHtml(instanceName());
    const closed = register.disabled || !register.allowNewRegistration;
    const inviteOnly = !closed && register.requireInvite;
    const email = general.correspondenceEmail?.trim();
    const contact = email ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : null;

    const actions = closed
        ? `<a class="button primary" href="/login">Sign in</a>`
        : `<a class="button primary" href="/register">Create an account</a><a class="button" href="/login">Sign in</a>`;

    const joinNote = closed
        ? "New accounts are closed right now. Existing accounts can still sign in."
        : inviteOnly
          ? "You need an invite link from someone already here to create an account."
          : "Signing up takes a minute and doesn't need a phone number.";

    const joinAnswer = closed
        ? `<p>${name} isn't taking new accounts right now.${contact ? ` You can ask the people who run it at ${contact}.` : ""}</p>`
        : inviteOnly
          ? `<p>Ask someone who already has an account for an invite link, then open it to create yours. Accounts created without an invite are turned away.</p>`
          : `<p>Pick <a href="/register">Create an account</a>, choose a username and password and solve a short check that proves you're human. An email address is only needed if this instance asks for one.</p>`;

    const faq: [string, string][] = [
        [
            `What is ${name}?`,
            `<p>${name} is a chat service with servers, channels, DMs, voice and video. It runs on <a href="https://github.com/meowcorded/meowcord">Meowcord</a>, a self-hosted server that speaks the same protocol as Discord, so the app in your browser looks and works the way you'd expect.</p>`,
        ],
        ["Is this Discord?", `<p>No. ${name} is its own service with its own accounts. Your Discord account doesn't work here, and nothing you post here is sent to Discord.</p>`],
        ["How do I join?", joinAnswer],
        [
            "Does anything cost money?",
            "<p>No. Every account gets every premium feature, every server is at the highest boost level, and every item in the shop is free. There's nothing to buy and no ads.</p>",
        ],
        [
            "Who can read my messages?",
            `<p>Direct messages and group DMs are end-to-end encrypted. Your browser encrypts them before they leave your device, so the server only stores ciphertext it can't read. Messages in server channels aren't end-to-end encrypted, and the people who run ${name} can access them.</p>`,
        ],
        [
            "Is there a desktop or mobile app?",
            `<p>${name} runs in any recent desktop or mobile browser, so there's nothing to install. Bookmark this page or add it to your home screen to open it like an app.</p>`,
        ],
        [
            `Who runs ${name}?`,
            `<p>${name} is run independently by its own operators, not by the Meowcord project.${contact ? ` You can reach them at ${contact}.` : ""} Read the <a href="/terms">terms</a>, the <a href="/privacy">privacy policy</a> and the <a href="/guidelines">community guidelines</a> before you join.</p>`,
        ],
    ];

    const description = general.instanceDescription?.trim();
    const page = fs.readFileSync(path.join(PUBLIC_ASSETS_FOLDER, "index.html"), "utf8");
    return brandPage(
        page
            .replaceAll("__TAGLINE__", description ? escapeHtml(description) : "Servers, channels, voice and encrypted DMs for you and your friends. Everything is free.")
            .replace("__ACTIONS__", actions)
            .replace("__JOIN_NOTE__", joinNote)
            .replace("__FAQ__", faq.map(([question, answer]) => `<details><summary>${question}</summary><div class="answer">${answer}</div></details>`).join(""))
            .replace("__CONTACT__", contact ? `<a href="mailto:${escapeHtml(email!)}">Contact</a>` : ""),
    );
};
