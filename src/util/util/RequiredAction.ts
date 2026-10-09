/* SPDX-License-Identifier: AGPL-3.0-only */
import { User } from "@spacebar/database";
import type { UserRequiredActionUpdateEvent } from "../interfaces";
import { Config } from "./Config";
import { emitEvent } from "./ipc/Event";

export const requiredAction = (user: Pick<User, "bot" | "verified">) => (Config.get().login.requireVerification && !user.bot && !user.verified ? "REQUIRE_VERIFIED_EMAIL" : null);

export async function emitRequiredAction(user_id: string) {
    const user = await User.findOneOrFail({ where: { id: user_id }, select: { id: true, bot: true, verified: true } });
    await emitEvent({
        event: "USER_REQUIRED_ACTION_UPDATE",
        user_id,
        data: { required_action: requiredAction(user) },
    } satisfies UserRequiredActionUpdateEvent);
}
