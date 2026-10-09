import {
    ApiError,
    Config,
    DiscordApiErrors,
    EVENT,
    FieldErrors,
    PermissionResolvable,
    Permissions,
    RightResolvable,
    Rights,
    SpacebarApiErrors,
    getPermission,
    getRights,
} from "@spacebar/util";
import { Channel } from "@spacebar/database";
import { AnyValidateFunction } from "ajv/dist/core";
import { NextFunction, Request, Response } from "express";
import { ajv } from "@spacebar/schemas";
import { BigNumber } from "bignumber.js";
import { FindOptionsRelations } from "typeorm";

const ignoredRequestSchemas = [
    // skip validation for settings proto JSON updates - TODO: figure out if this even possible to fix?
    "SettingsProtoUpdateJsonSchema",
];

declare global {
    // TODO: fix this
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            permission?: Permissions;
            channel?: Channel;
        }
    }
}

export type RouteResponse = {
    status?: number;
    body?: `${string}Response`;
    headers?: Record<string, string>;
};
export type stripNulls = { [key: string]: true | stripNulls };
export interface RouteOptions {
    permission?: PermissionResolvable;
    channelRelations?: FindOptionsRelations<Channel>;
    right?: RightResolvable;
    requestBody?: `${string}Schema`; // typescript interface name
    responses?: {
        [status: number]: {
            // body?: `${string}Response`;
            body?: string;
        };
    };
    stripNulls?: stripNulls | true;
    event?: EVENT | EVENT[];
    summary?: string;
    description?: string;
    query?: {
        [key: string]: {
            type: string;
            required?: boolean;
            description?: string;
            values?: string[];
            default?: unknown;
        };
    };
    deprecated?: boolean;
    spacebarOnly?: boolean;
    // test?: {
    // 	response?: RouteResponse;
    // 	body?: unknown;
    // 	path?: string;
    // 	event?: EVENT | EVENT[];
    // 	headers?: Record<string, string>;
    // };

    /**
     * @defaultValue "required"
     */
    authentication?: "never" | "optional" | "required";
    oauth2?: string[];
    allowUnverified?: boolean;
}
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export function stripNull(obj: object) {
    for (const [key, value] of Object.entries(obj)) {
        if (value instanceof Object || (value && !value.__proto__)) {
            stripNull(value);
        } else if (value === null) {
            //@ts-expect-error this is fine
            delete obj[key];
        }
    }
}
// eslint-disable-next-line
export function followNullPath(obj1: any, nullObj: stripNulls) {
    for (const [key, value] of Object.entries(nullObj)) {
        if (key in obj1)
            if (value instanceof Object) {
                if (obj1[key] instanceof Object)
                    //@ts-expect-error this works lol
                    followNullPath(obj1[key], nullObj[key]);
                else delete obj1[key];
            } else if (obj1[key] instanceof Object) {
                stripNull(obj1[key]);
            }
    }
}
//It's pretty safe to assume numbers over the number limit aren't really meant to be numbers, so we turn them to strings.
export function bigNumberToString(obj1: unknown) {
    if (obj1 && typeof obj1 === "object") {
        for (const [key, value] of Object.entries(obj1)) {
            if (typeof value === "object") {
                if (value instanceof BigNumber) {
                    //@ts-expect-error this is fine lol
                    obj1[key] = value.toString();
                }
                bigNumberToString(value);
            }
        }
    }
}
export function route(opts: RouteOptions) {
    let validate: AnyValidateFunction | undefined;
    if (opts.requestBody) {
        try {
            validate = ajv.getSchema(opts.requestBody);
        } catch (e) {
            console.error("AJV getSchema failed!");
            throw e;
        }

        if (!validate) throw new Error(`Body schema ${opts.requestBody} not found`);
    }

    opts.authentication ??= "required";

    return async (req: Request, res: Response, next: NextFunction) => {
        const applicationParam = (req.params as Record<string, string | undefined>).application_id;
        if (req.oauth2 && applicationParam !== undefined && applicationParam !== req.oauth2.application_id) throw new ApiError("401: Unauthorized", 0, 401);
        if (req.oauth2 && !(opts.oauth2 && (!opts.oauth2.length || opts.oauth2.some((scope) => req.oauth2!.scopes.includes(scope))))) {
            if (opts.authentication === "required") throw new ApiError("401: Unauthorized", 0, 401);
            Object.assign(req, {
                isAuthenticated: false,
                user_id: undefined,
                user: undefined,
                oauth2: undefined,
            });
        }
        if (opts.authentication === "required" && !req.isAuthenticated) throw new ApiError("401: Unauthorized", 0, 401);
        if (
            opts.authentication === "required" &&
            !opts.allowUnverified &&
            !READ_METHODS.has(req.method) &&
            req.user?.verified === false &&
            !req.user.bot &&
            Config.get().login.requireVerification
        )
            throw DiscordApiErrors.ACCOUNT_VERIFICATION_REQUIRED;

        const malformed = (["channel_id", "message_id"] as const).find((key) => {
            const value = (req.params as Record<string, string | undefined>)[key];
            return value !== undefined && value !== "@original" && !/^\d{1,20}$/.test(value);
        });
        if (malformed)
            throw FieldErrors({
                [malformed]: {
                    code: "NUMBER_TYPE_COERCE",
                    message: `Value "${(req.params as Record<string, string>)[malformed]}" is not snowflake.`,
                },
            });

        if (opts.permission) {
            const { guild_id, channel_id } = req.params as { [key: string]: string };
            const user = req.user?.id === req.user_id ? req.user : undefined;
            if (opts.channelRelations && channel_id) {
                req.channel = await Channel.findOneOrFail({
                    where: { id: channel_id },
                    relations: opts.channelRelations,
                });
                req.permission = await getPermission(req.user_id, req.channel.guild_id || guild_id, req.channel, { user });
            } else req.permission = await getPermission(req.user_id, guild_id, channel_id, { user });

            const requiredPerms = Array.isArray(opts.permission) ? opts.permission : [opts.permission];
            requiredPerms.forEach((perm) => {
                // bitfield comparison: check if user lacks certain permission
                if (!req.permission!.has(new Permissions(perm))) throw perm === "VIEW_CHANNEL" ? DiscordApiErrors.MISSING_ACCESS : DiscordApiErrors.MISSING_PERMISSIONS;
            });
        }

        if (opts.right) {
            const required = new Rights(opts.right);
            req.rights = req.user?.id === req.user_id && req.user.rights !== undefined ? new Rights(req.user.rights) : await getRights(req.user_id);

            if (!req.rights || !req.rights.has(required)) {
                throw SpacebarApiErrors.MISSING_RIGHTS.withParams(opts.right as string);
            }
        }
        bigNumberToString(req.body);

        if (validate && !ignoredRequestSchemas.includes(opts.requestBody!)) {
            if (opts.stripNulls) {
                if (opts.stripNulls === true) stripNull(req.body);
                else followNullPath(req.body, opts.stripNulls);
            }

            const valid = validate(req.body);
            if (!valid) {
                const fields: Record<string, { code?: string; message: string }> = {};
                validate.errors?.forEach((x) => {
                    const limit = (x.params as { limit?: number }).limit;
                    fields[x.instancePath.slice(1).replaceAll("/", ".")] =
                        x.keyword === "maxLength" || x.keyword === "maxItems"
                            ? { code: "BASE_TYPE_MAX_LENGTH", message: `Must be ${limit} or fewer in length.` }
                            : x.keyword === "minLength" || x.keyword === "minItems"
                              ? { code: "BASE_TYPE_MIN_LENGTH", message: `Must be ${limit} or more in length.` }
                              : { code: x.keyword, message: x.message || "" };
                });
                if (process.env.LOG_VALIDATION_ERRORS) console.log(`[VALIDATION ERROR] ${req.method} ${req.originalUrl} - SCHEMA='${opts.requestBody}' -`, validate?.errors);
                throw FieldErrors(fields, validate.errors!);
            }
        }
        next();
    };
}
