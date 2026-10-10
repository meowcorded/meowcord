import { isSqlite } from "@spacebar/database/Sql";
import { Message, User, UserViolation } from "@spacebar/database";
import { Config, emitEvent, getRights, MessageUpdateEvent } from "@spacebar/util";
import { AccountStandingState, AdminViolationCreateSchema, AppealStatusValue, Embed, EmbedType } from "@spacebar/schemas";
import { accountStanding, getUserViolations, VIOLATION_TYPE_LABELS } from "./accountStanding";
import { standingLink } from "./safetyMessageText";
import { getSystemAccount, sendSystemDM } from "./systemAccounts";

// What users and staff hear about violations: the official account DMs users (violation notices, standing drops,
// appeal outcomes) using the client's own safety embeds, and the appeals account sends staff a review per appeal.

const APPEAL_REASONS = ["They didn't break the rules", "The decision was too strict or unfair", "They disagree with the penalty", "Something else"];
const STANDING_NAMES: Partial<Record<AccountStandingState, string>> = {
    [AccountStandingState.LIMITED]: "limited",
    [AccountStandingState.VERY_LIMITED]: "very limited",
    [AccountStandingState.AT_RISK]: "at risk",
    [AccountStandingState.SUSPENDED]: "suspended",
};

const unix = (date: Date) => String(Math.floor(date.getTime() / 1000));
const field = (name: string, value: string) => ({ name, value });

// the card clients draw for safety_system_notification embeds: icon/theme are "default" or "danger", ctas are
// "policy_violation_detail" (See Details, opens the violation) and "learn_more_link"
function systemNotification(opts: { header: string; body: string; danger?: boolean; classificationId?: string; learnMore?: string | null }): Embed {
    const ctas = opts.learnMore ? "learn_more_link" : opts.classificationId ? "policy_violation_detail" : "learn_more_link";
    return {
        type: "safety_system_notification" as EmbedType,
        fields: [
            field("icon_type", opts.danger ? "danger" : "default"),
            field("theme", opts.danger ? "danger" : "default"),
            field("header", opts.header),
            field("body", opts.body),
            field("timestamp", unix(new Date())),
            field("ctas", ctas),
            ...(opts.classificationId ? [field("classification_id", opts.classificationId)] : []),
            ...(opts.learnMore ? [field("learn_more_link", opts.learnMore)] : !opts.classificationId ? [field("learn_more_link", standingLink)] : []),
        ],
    };
}

const quietly = (what: string, promise: Promise<unknown>) => promise.catch((e) => console.error(`[Safety] couldn't ${what}`, e));

/** "You broke <instance>'s community guidelines" with a Learn more that opens the violation. */
export const notifyViolation = (violation: UserViolation) =>
    quietly(
        "send a violation notice",
        sendSystemDM("official", violation.user_id, {
            embeds: [
                {
                    type: "safety_policy_notice" as EmbedType,
                    fields: [field("classification_id", violation.id), field("incident_time", unix(violation.created_at))],
                },
            ],
        }),
    );

/** Tells the user when their standing gets worse (limited, very limited, at risk or suspended). */
export async function notifyStandingDrop(user_id: string, before: AccountStandingState, after: AccountStandingState, latestViolationId?: string) {
    if (after <= before || !STANDING_NAMES[after]) return;
    const name = STANDING_NAMES[after];
    await quietly(
        "send a standing notice",
        sendSystemDM("official", user_id, {
            embeds: [
                systemNotification({
                    danger: true,
                    header: `Your account is ${name}`,
                    body: `Because of violations of our community guidelines, your account standing is now ${name}. Violations stop affecting your standing once they expire. You can review them, and appeal ones you think are wrong, on your Account Standing page.`,
                    classificationId: latestViolationId,
                }),
            ],
        }),
    );
}

export async function currentStanding(user_id: string) {
    const user = await User.findOneOrFail({
        where: { id: user_id },
        select: { id: true, disabled: true, account_standing: true },
    });
    return accountStanding(user, await getUserViolations(user_id));
}

const reviewEmbed = (violation: UserViolation, user: User): Embed => ({
    type: EmbedType.rich,
    title: `Appeal: ${VIOLATION_TYPE_LABELS[violation.classification_type] ?? "Violation"}`,
    color: 0xf0b232,
    description: violation.appeal_user_input?.trim()
        ? violation.appeal_user_input
              .trim()
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n")
        : "*They didn't add a message.*",
    fields: [
        { name: "User", value: `<@${user.id}> (@${user.username})`, inline: true },
        {
            name: "Reason",
            value: APPEAL_REASONS[violation.appeal_signal ?? 3] ?? APPEAL_REASONS[3],
            inline: true,
        },
        { name: "Violation", value: violation.description.slice(0, 1024) },
        { name: "Issued", value: `<t:${unix(violation.created_at)}:R>`, inline: true },
        {
            name: "Expires",
            value: violation.expires_at.getFullYear() >= 2100 ? "Never" : `<t:${unix(violation.expires_at)}:R>`,
            inline: true,
        },
    ],
    footer: {
        text: `React ✅ to remove the violation or ❌ to reject the appeal. The first staff vote decides. • ${violation.id}`,
    },
});

// anyone who can manage users can decide appeals
async function staffMembers() {
    const staff = await User.createQueryBuilder("u")
        .select(["u.id", "u.rights"])
        .where("u.deleted = false AND u.disabled = false AND u.bot = false AND u.system = false")
        .andWhere("(u.rights & :mask) != 0", { mask: 1 + 128 }) // OPERATOR | MANAGE_USERS
        .getMany();
    return staff.map((u) => u.id);
}

/** Records the user's appeal and sends every staff member a review to vote on. */
export async function requestAppeal(violation: UserViolation, signal: number | null, userInput: string | null) {
    violation.appeal_status = AppealStatusValue.REVIEW_PENDING;
    violation.appealed_at = new Date();
    violation.appeal_signal = signal;
    violation.appeal_user_input = userInput?.slice(0, 2000) || null;
    await violation.save();

    const [user, appeals] = await Promise.all([User.findOneOrFail({ where: { id: violation.user_id }, select: { id: true, username: true } }), getSystemAccount("appeals")]);
    const votes = ["✅", "❌"].map((name) => ({
        count: 1,
        emoji: { name },
        user_ids: [appeals.id],
        burst_user_ids: [],
        burst_colors: [],
    }));
    const sent: { channel_id: string; message_id: string }[] = [];
    for (const staffId of await staffMembers()) {
        try {
            const message = await sendSystemDM("appeals", staffId, {
                embeds: [reviewEmbed(violation, user)],
                reactions: votes,
            });
            sent.push({ channel_id: message.channel_id!, message_id: message.id });
        } catch (e) {
            console.error(`[Safety] couldn't send an appeal review to ${staffId}`, e);
        }
    }
    violation.appeal_review_messages = sent;
    await violation.save();
}

/**
 * Decides a pending appeal: approved overturns the violation (it stops counting), rejected upholds it. The user is
 * told through the official account and every staff review is marked with the outcome. False if nothing was pending.
 */
export async function resolveAppeal(violation: UserViolation, approved: boolean, staffId: string) {
    if (violation.appeal_status !== AppealStatusValue.REVIEW_PENDING) return false;
    violation.appeal_status = approved ? AppealStatusValue.CLASSIFICATION_INVALIDATED : AppealStatusValue.CLASSIFICATION_UPHELD;
    violation.appeal_resolved_by = staffId;
    await violation.save();

    const { general } = Config.get();
    const learnMore = general.tosPage || general.frontPage;
    await quietly(
        "send an appeal decision",
        sendSystemDM("official", violation.user_id, {
            embeds: [
                approved
                    ? systemNotification({
                          header: "We have removed a violation from your account",
                          body: "At your request, we've reviewed your content and determined that it does not violate our community guidelines. We have removed this violation from your account. We are always working to improve our process. We appreciate your patience and contributions to our community.",
                          learnMore,
                          classificationId: violation.id,
                      })
                    : systemNotification({
                          header: "We've confirmed that your content broke our rules",
                          body: "At your request, we reviewed your content and confirmed it violates our community guidelines. This violation still affects your account until it expires. Familiarise yourself with our Community Guidelines and Terms of Service.",
                          classificationId: violation.id,
                      }),
            ],
        }),
    );

    // every staff copy of the review shows the decision, so nobody votes on a closed appeal
    const staff = await User.findOne({
        where: { id: staffId },
        select: { id: true, username: true },
    });
    for (const { channel_id, message_id } of violation.appeal_review_messages ?? []) {
        const message = await Message.findOne({ where: { id: message_id, channel_id } });
        const embed = message?.embeds?.[0];
        if (!message || !embed) continue;
        embed.color = approved ? 0x23a55a : 0xda373c;
        embed.fields = [
            ...(embed.fields ?? []),
            {
                name: "Decision",
                value: `${approved ? "✅ Violation removed" : "❌ Appeal rejected"} by <@${staffId}>${staff ? ` (@${staff.username})` : ""}`,
            },
        ];
        embed.footer = { text: `Decided ${new Date().toUTCString()} • ${violation.id}` };
        await Message.update({ id: message.id, channel_id }, { embeds: message.embeds });
        await emitEvent({
            event: "MESSAGE_UPDATE",
            channel_id,
            data: { ...message.toJSON(), nonce: undefined },
        } satisfies MessageUpdateEvent);
    }
    return true;
}

/** Called for every reaction: a staff ✅ or ❌ on an appeal review decides that appeal. */
export async function handleAppealVote(message_id: string, voterId: string, emoji: string) {
    if (emoji !== "✅" && emoji !== "❌") return;
    const violation = await UserViolation.createQueryBuilder("v")
        .where(isSqlite() ? "EXISTS (SELECT 1 FROM json_each(v.appeal_review_messages) WHERE value ->> 'message_id' = :message_id)" : "v.appeal_review_messages @> :match", {
            match: JSON.stringify([{ message_id }]),
            message_id,
        })
        .getOne();
    if (!violation || violation.appeal_status !== AppealStatusValue.REVIEW_PENDING) return;
    if (!(await getRights(voterId)).has("MANAGE_USERS")) return;
    await resolveAppeal(violation, emoji === "✅", voterId);
}

export const PERMANENT_VIOLATION_EXPIRY = new Date("2100-01-01T00:00:00Z");

export async function issueViolation(user_id: string, body: AdminViolationCreateSchema, issued_by: string, flagged_content: unknown[] = []) {
    const before = await currentStanding(user_id);
    const violation = await UserViolation.create({
        user_id,
        classification_type: body.classification_type,
        description: body.description.trim(),
        actions: (body.actions ?? []).map((a) => ({
            action_type: a.action_type,
            descriptions: (a.descriptions ?? []).map((d) => d.trim()).filter(Boolean),
        })),
        flagged_content,
        issued_by,
        expires_at: body.expires_in_days ? new Date(Date.now() + body.expires_in_days * 24 * 60 * 60 * 1000) : PERMANENT_VIOLATION_EXPIRY,
    }).save();
    await notifyViolation(violation);
    await notifyStandingDrop(user_id, before, await currentStanding(user_id), violation.id);
    return violation;
}
