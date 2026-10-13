import { IsNull, MoreThan } from "typeorm";
import fs from "node:fs/promises";
import path from "node:path";
import { Request, Response, Router } from "express";
import { HTTPError } from "lambert-server/HTTPError";
import { route } from "@spacebar/api/middlewares";
import { Guild, User } from "@spacebar/database";
import { ASSETS_FOLDER, Config, inRollout, rolloutBucket } from "@spacebar/util";
const router = Router({ mergeParams: true });
let catalog: Promise<string[]> | undefined;
const NAME = /["'`](20\d\d[-_]\d\d[-_][a-zA-Z0-9_-]+)["'`]/g;
const scanClient = async () => {
    const dir = path.join(ASSETS_FOLDER, "cache");
    const names = new Set<string>();
    for (const file of await fs.readdir(dir).catch(() => [] as string[])) {
        if (!file.endsWith(".js")) continue;
        for (const match of (await fs.readFile(path.join(dir, file), "utf8")).matchAll(NAME)) names.add(match[1]);
    }
    return [...names].sort().reverse();
};
type Grants = Record<string, Record<string, number>>;
router.get(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Experiments granted to users and guilds, plus the instance-wide overrides",
    }),
    async (req: Request, res: Response) => {
        const { experiments, userExperiments, guildExperiments, rolloutExperiments } = Config.get().client;
        res.json({
            global: experiments,
            users: userExperiments ?? {},
            guilds: guildExperiments ?? {},
            rollouts: rolloutExperiments ?? {},
            users_total: await User.count({ where: { bot: false, federated_instance: IsNull() } }),
        });
    },
);
router.get(
    "/catalog",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Experiment names found in the cached web client",
    }),
    async (req: Request, res: Response) => {
        res.json(await (catalog ??= scanClient()));
    },
);
router.put(
    "/",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Grant (or with variant 0 revoke) an experiment for a user, a guild, or a user and their guilds",
    }),
    async (req: Request, res: Response) => {
        const {
            target,
            name,
            variant = 1,
            include_owned_guilds,
        } = (req.body ?? {}) as {
            target?: string;
            id?: string;
            name?: string;
            variant?: number;
            include_owned_guilds?: boolean;
        };
        const id = req.body?.id === "@me" ? req.user_id : req.body?.id;
        if (target !== "user" && target !== "guild" && target !== "global") throw new HTTPError("target must be user, guild or global", 400);
        if (target !== "global" && (typeof id !== "string" || !/^\d{1,32}$/.test(id))) throw new HTTPError("id must be a snowflake or @me", 400);
        if (typeof name !== "string" || !/^[\w.-]{1,128}$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name))
            throw new HTTPError("name must be an experiment name", 400);
        if (!Number.isInteger(variant) || variant < 0 || variant > 1000) throw new HTTPError("variant must be a non-negative integer", 400);
        const client = Config.get().client;
        client.userExperiments ??= {};
        client.guildExperiments ??= {};
        const apply = (grants: Grants, key: string) => {
            if (variant === 0) {
                delete grants[key]?.[name];
                if (grants[key] && !Object.keys(grants[key]).length) delete grants[key];
            } else (grants[key] ??= {})[name] = variant;
        };
        const guilds: string[] = [];
        if (target === "global") {
            if (variant === 0) delete client.experiments[name];
            else client.experiments[name] = variant;
        } else if (target === "guild") {
            apply(client.guildExperiments, id);
            guilds.push(id);
        } else {
            apply(client.userExperiments, id);
            if (include_owned_guilds) {
                for (const guild of await Guild.find({ where: { owner_id: id }, select: { id: true } })) {
                    apply(client.guildExperiments, guild.id);
                    guilds.push(guild.id);
                }
            }
        }
        await Config.set({});
        res.json({ target, id, name, variant, guilds });
    },
);
router.put(
    "/rollout",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Roll an experiment out to a percentage of users (0 removes the rollout)",
    }),
    async (req: Request, res: Response) => {
        const { name, percent, variant = 1 } = (req.body ?? {}) as { name?: string; percent?: number; variant?: number };
        if (typeof name !== "string" || !/^[\w.-]{1,128}$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name))
            throw new HTTPError("name must be an experiment name", 400);
        if (typeof percent !== "number" || !(percent >= 0 && percent <= 100)) throw new HTTPError("percent must be between 0 and 100", 400);
        if (!Number.isInteger(variant) || variant < 1 || variant > 1000) throw new HTTPError("variant must be a positive integer", 400);

        const client = Config.get().client;
        client.rolloutExperiments ??= {};
        const rounded = Math.round(percent * 100) / 100;
        if (rounded === 0) delete client.rolloutExperiments[name];
        else client.rolloutExperiments[name] = { percent: rounded, variant };
        await Config.set({});
        res.json({ name, percent: rounded, variant });
    },
);

router.get(
    "/rollout/:name/users",
    route({
        right: "OPERATOR",
        spacebarOnly: true,
        description: "Users an experiment rollout reaches",
    }),
    async (req: Request, res: Response) => {
        const { name } = req.params as { name: string };
        const rollout = Config.get().client.rolloutExperiments?.[name];
        if (!rollout) throw new HTTPError("No rollout for that experiment", 404);
        const after = req.query.after;
        if (after !== undefined && (typeof after !== "string" || !/^\d{1,32}$/.test(after))) throw new HTTPError("Invalid user cursor", 400);
        const page = await User.find({
            where: { bot: false, federated_instance: IsNull(), ...(after ? { id: MoreThan(after) } : {}) },
            select: { id: true, username: true, discriminator: true, global_name: true, avatar: true },
            order: { id: "ASC" },
            take: 2001,
        });
        const scanned = page.slice(0, 2000);
        const users = scanned
            .filter((user) => inRollout(name, user.id, rollout.percent))
            .map((user) => ({
                id: user.id,
                username: user.username,
                discriminator: user.discriminator,
                global_name: user.global_name ?? null,
                avatar: user.avatar,
                bucket: rolloutBucket(name, user.id),
            }));
        res.json({
            name,
            percent: rollout.percent,
            variant: rollout.variant,
            users,
            next_cursor: page.length > 2000 ? scanned.at(-1)?.id : null,
        });
    },
);

export default router;
